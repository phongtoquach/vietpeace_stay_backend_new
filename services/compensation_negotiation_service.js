const { randomBytes } = require("node:crypto");
const db = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const { getAccommodationScope } = require("./accommodation_access_service");
const { emitCompensationEvent } = require("./chat/runtime");
const {
  CheckoutSettlementError,
  getCheckoutFolio,
  fetchBookingCoreFixedSql,
  fetchInvoiceRow,
  assertStayEditableForCharges,
  cancelPendingOnlineSettlementsInTx,
  runInTransaction,
  mapNegotiationRow,
  parsePositiveInt,
  validationError,
  invalidStateError,
} = require("./checkout_settlement_service");

const sql = db.sqlObj;

const NEGOTIATION_STATUSES = Object.freeze([
  "PENDING",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "REJECTED",
  "CANCELLED",
]);

const MAX_EVIDENCE_IMAGES = 5;

function buildNegotiationCode(date = new Date()) {
  const vnMillis = date.getTime() + 7 * 60 * 60 * 1000;
  const d = new Date(vnMillis);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rand = randomBytes(3).toString("hex").toUpperCase();
  return `NEG-${yy}${mm}${dd}-${rand}`;
}

function sanitizeEvidenceImages(rawImages) {
  if (rawImages === undefined || rawImages === null) return [];
  if (!Array.isArray(rawImages)) {
    throw validationError("Danh sách hình ảnh bằng chứng không hợp lệ.", {
      evidenceImages: "Phải là mảng đường dẫn hình ảnh.",
    });
  }
  if (rawImages.length > MAX_EVIDENCE_IMAGES) {
    throw validationError(`Chỉ được đính kèm tối đa ${MAX_EVIDENCE_IMAGES} hình ảnh cho mỗi phiếu thương lượng.`, {
      evidenceImages: `Tối đa ${MAX_EVIDENCE_IMAGES} ảnh.`,
    });
  }

  const seen = new Set();
  const cleaned = [];
  for (const raw of rawImages) {
    const url = String(raw || "").trim();
    if (!url) continue;
    if (!/^\/uploads\/checkout_evidence\/[A-Za-z0-9._-]+$/i.test(url) || url.length > 500) {
      throw validationError("Đường dẫn ảnh bằng chứng không hợp lệ. Vui lòng tải ảnh qua mục Upload.", {
        evidenceImages: "Ảnh bằng chứng phải được tải lên qua hệ thống.",
      });
    }
    if (!seen.has(url)) {
      seen.add(url);
      cleaned.push(url);
    }
  }
  return cleaned;
}

function computeProposalSnapshot({
  quantity,
  unitPrice,
  depreciationPercent,
  adjustmentAmount,
  requestedExtraReduction,
}) {
  const qty = Number(quantity || 1);
  const price = Number(unitPrice || 0);
  const depPct = Number(depreciationPercent ?? 100);
  const originalGrossAmount = Math.round(qty * price * (depPct / 100));
  const previousAdjustmentAmount = Math.max(0, Math.round(Number(adjustmentAmount || 0)));
  const previousFinalAmount = Math.max(0, originalGrossAmount - previousAdjustmentAmount);

  if (previousFinalAmount <= 0) {
    throw invalidStateError("Khoản bồi thường này hiện đang bằng 0 đ, không cần gửi yêu cầu thương lượng giảm.");
  }

  const reqReductionRaw = Number(requestedExtraReduction);
  if (!Number.isFinite(reqReductionRaw) || reqReductionRaw <= 0) {
    throw validationError("Số tiền xin giảm thêm phải lớn hơn 0 đ.", {
      requestedExtraReduction: "Nhập số tiền cần xin giảm lớn hơn 0 đ.",
    });
  }
  const requestedReduction = Math.round(reqReductionRaw);
  if (requestedReduction > previousFinalAmount) {
    throw validationError(
      `Số tiền xin giảm (${requestedReduction.toLocaleString("vi-VN")} đ) không được vượt quá số tiền đang yêu cầu đền (${previousFinalAmount.toLocaleString("vi-VN")} đ).`,
      {
        requestedExtraReduction: `Tối đa ${previousFinalAmount.toLocaleString("vi-VN")} đ.`,
      },
    );
  }

  return {
    originalGrossAmount,
    previousAdjustmentAmount,
    previousFinalAmount,
    requestedExtraReduction: requestedReduction,
    proposedFinalAmount: previousFinalAmount - requestedReduction,
  };
}

function computeReviewOutcome({
  originalGrossAmount,
  previousAdjustmentAmount,
  previousFinalAmount,
  requestedExtraReduction,
  decision,
  approvedExtraReduction,
}) {
  const normalizedDecision = String(decision || "").trim().toUpperCase();
  if (!["APPROVE", "REJECT"].includes(normalizedDecision)) {
    throw validationError("Quyết định thẩm định không hợp lệ (chọn APPROVE hoặc REJECT).", {
      decision: "Chỉ chấp nhận APPROVE hoặc REJECT.",
    });
  }

  if (normalizedDecision === "REJECT") {
    return {
      status: "REJECTED",
      approvedExtraReduction: 0,
      finalApprovedAmount: previousFinalAmount,
      nextAdjustmentAmount: previousAdjustmentAmount,
      nextTotalAmount: previousFinalAmount,
    };
  }

  const approvedRaw =
    approvedExtraReduction !== undefined && approvedExtraReduction !== null && approvedExtraReduction !== ""
      ? Number(approvedExtraReduction)
      : requestedExtraReduction;

  if (!Number.isFinite(approvedRaw) || approvedRaw <= 0) {
    throw validationError(
      "Số tiền Admin xác nhận giảm phải lớn hơn 0 đ. Nếu không đồng ý giảm, vui lòng chọn Từ chối.",
      {
        approvedExtraReduction: "Nhập số tiền giảm > 0 đ hoặc chọn Từ chối.",
      },
    );
  }

  const approved = Math.round(approvedRaw);
  if (approved > previousFinalAmount) {
    throw validationError(
      `Số tiền xác nhận giảm (${approved.toLocaleString("vi-VN")} đ) không được vượt quá mức đang yêu cầu đền (${previousFinalAmount.toLocaleString("vi-VN")} đ).`,
      {
        approvedExtraReduction: `Tối đa ${previousFinalAmount.toLocaleString("vi-VN")} đ.`,
      },
    );
  }

  const nextStatus = approved === Number(requestedExtraReduction) ? "APPROVED" : "PARTIALLY_APPROVED";
  const finalApprovedAmount = previousFinalAmount - approved;
  const nextAdjustmentAmount = Math.min(originalGrossAmount, previousAdjustmentAmount + approved);
  const nextTotalAmount = Math.max(0, originalGrossAmount - nextAdjustmentAmount);

  return {
    status: nextStatus,
    approvedExtraReduction: approved,
    finalApprovedAmount,
    nextAdjustmentAmount,
    nextTotalAmount,
  };
}

async function fetchPropertyManagerUserIds(executor, accommodationId, extraUserId = null) {
  const res = await new sql.Request(executor)
    .input("accId", sql.Int, Number(accommodationId))
    .query(`
      SELECT DISTINCT user_id
      FROM dbo.accommodation_managers
      WHERE accommodation_id = @accId;
    `);
  const ids = new Set(res.recordset.map((r) => String(r.user_id)));
  if (extraUserId) ids.add(String(extraUserId));
  return [...ids];
}

async function fetchNegotiationDetailRaw(executor, negotiationId, currentUser = {}, { lock = false } = {}) {
  const scope = getAccommodationScope(currentUser, "a");
  const lockHint = lock ? "WITH (UPDLOCK, HOLDLOCK)" : "";
  const req = new sql.Request(executor).input("negId", sql.BigInt, negotiationId);
  scope.inputs.forEach((inp) => req.input(inp.name, inp.type, inp.value));

  const res = await req.query(`
    SELECT
      n.*,
      CONVERT(VARCHAR(18), n.version, 1) AS version_token,
      b.booking_code,
      b.contact_name,
      b.contact_phone,
      a.accommodation_name,
      ru.full_name AS requested_by_name,
      vu.full_name AS reviewed_by_name
    FROM dbo.compensation_negotiations n ${lockHint}
    JOIN dbo.bookings b ON b.id = n.booking_id
    JOIN dbo.accommodations a ON a.id = n.accommodation_id
    LEFT JOIN dbo.users ru ON ru.id = n.requested_by
    LEFT JOIN dbo.users vu ON vu.id = n.reviewed_by
    WHERE n.id = @negId
      AND ${scope.condition};
  `);

  return res.recordset[0] || null;
}

async function createNegotiationProposal(bookingId, payload = {}, currentUser = {}) {
  const bId = parsePositiveInt(bookingId);
  const chargeId = parsePositiveInt(payload.chargeId);
  if (!bId || !chargeId) {
    throw validationError("Mã đặt phòng hoặc mã khoản bồi thường không hợp lệ.");
  }

  const guestOpinion = String(payload.guestOpinion || "").trim();
  if (guestOpinion.length < 5 || guestOpinion.length > 1000) {
    throw validationError("Vui lòng ghi rõ ý kiến / lý do xin giảm của khách hàng (từ 5 đến 1.000 ký tự).", {
      guestOpinion: "Ý kiến khách hàng phải từ 5 đến 1.000 ký tự.",
    });
  }

  const managerNoteRaw = payload.managerNote !== undefined && payload.managerNote !== null
    ? String(payload.managerNote).trim()
    : "";
  if (managerNoteRaw.length > 1000) {
    throw validationError("Nhận xét của Quản lý cơ sở tối đa 1.000 ký tự.", {
      managerNote: "Tối đa 1.000 ký tự.",
    });
  }
  const managerNote = managerNoteRaw || null;
  const isUrgent = Boolean(payload.isUrgent);
  const uploadedImages = sanitizeEvidenceImages(payload.evidenceImages);

  const pool = db.getDBPool();

  const { negotiation, managerUserIds } = await runInTransaction(pool, async (tx) => {
    const bookingRow = await fetchBookingCoreFixedSql(tx, bId, currentUser, { lock: true });
    const invoiceRow = bookingRow ? await fetchInvoiceRow(tx, bId, { lock: true }) : null;
    assertStayEditableForCharges(bookingRow, invoiceRow);

    const chargeRes = await new sql.Request(tx)
      .input("chargeId", sql.BigInt, chargeId)
      .input("bookingId", sql.BigInt, bId)
      .query(`
        SELECT *
        FROM dbo.booking_incidental_charges WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @chargeId AND booking_id = @bookingId;
      `);
    const charge = chargeRes.recordset[0];
    if (!charge) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy khoản bồi thường trên đơn này.");
    }
    if (charge.status !== "ACTIVE") {
      throw invalidStateError("Khoản bồi thường đã bị hủy, không thể lập phiếu thương lượng.");
    }
    if (charge.category !== "DAMAGE_COMPENSATION") {
      throw validationError("Chỉ hỗ trợ thương lượng giảm giá trị cho nhóm Bồi thường hư hỏng thiết bị.");
    }

    const pendingRes = await new sql.Request(tx)
      .input("chargeId", sql.BigInt, chargeId)
      .query(`
        SELECT id
        FROM dbo.compensation_negotiations WITH (UPDLOCK, HOLDLOCK)
        WHERE charge_id = @chargeId AND status = 'PENDING';
      `);
    if (pendingRes.recordset.length > 0) {
      throw invalidStateError("Thiết bị này đang có phiếu đề xuất thương lượng chờ Admin phản hồi.");
    }

    // Merge existing charge photo (if valid local upload) + newly uploaded photos (up to 5)
    const combinedImages = [...uploadedImages];
    if (
      charge.evidence_image_url &&
      /^\/uploads\/checkout_evidence\/[A-Za-z0-9._-]+$/i.test(charge.evidence_image_url) &&
      !combinedImages.includes(charge.evidence_image_url) &&
      combinedImages.length < MAX_EVIDENCE_IMAGES
    ) {
      combinedImages.push(charge.evidence_image_url);
    }

    const snap = computeProposalSnapshot({
      quantity: charge.quantity,
      unitPrice: charge.unit_price,
      depreciationPercent: charge.depreciation_percent,
      adjustmentAmount: charge.adjustment_amount,
      requestedExtraReduction: payload.requestedExtraReduction,
    });

    if (!charge.evidence_image_url && combinedImages.length > 0) {
      await new sql.Request(tx)
        .input("chargeId", sql.BigInt, chargeId)
        .input("evidenceUrl", sql.NVarChar(500), combinedImages[0])
        .query(`
          UPDATE dbo.booking_incidental_charges
          SET evidence_image_url = @evidenceUrl, updated_at = SYSDATETIME()
          WHERE id = @chargeId AND evidence_image_url IS NULL;
        `);
    }

    const negotiationCode = buildNegotiationCode();
    const insertRes = await new sql.Request(tx)
      .input("negotiationCode", sql.VarChar(40), negotiationCode)
      .input("chargeId", sql.BigInt, chargeId)
      .input("bookingId", sql.BigInt, bId)
      .input("accommodationId", sql.Int, Number(bookingRow.accommodation_id))
      .input("itemName", sql.NVarChar(200), charge.item_name)
      .input("quantity", sql.Int, Number(charge.quantity))
      .input("unitPrice", sql.Decimal(18, 0), Number(charge.unit_price))
      .input("compensationMode", sql.VarChar(30), charge.compensation_mode)
      .input("depreciationPercent", sql.Decimal(5, 2), Number(charge.depreciation_percent))
      .input("originalGrossAmount", sql.Decimal(18, 0), snap.originalGrossAmount)
      .input("previousAdjustmentAmount", sql.Decimal(18, 0), snap.previousAdjustmentAmount)
      .input("previousFinalAmount", sql.Decimal(18, 0), snap.previousFinalAmount)
      .input("requestedExtraReduction", sql.Decimal(18, 0), snap.requestedExtraReduction)
      .input("proposedFinalAmount", sql.Decimal(18, 0), snap.proposedFinalAmount)
      .input("guestOpinion", sql.NVarChar(1000), guestOpinion)
      .input("managerNote", sql.NVarChar(1000), managerNote)
      .input("evidenceImagesJson", sql.NVarChar(sql.MAX), JSON.stringify(combinedImages))
      .input("isUrgent", sql.Bit, isUrgent ? 1 : 0)
      .input("requestedBy", sql.UniqueIdentifier, currentUser.id)
      .query(`
        INSERT INTO dbo.compensation_negotiations (
          negotiation_code, charge_id, booking_id, accommodation_id,
          item_name, quantity, unit_price, compensation_mode, depreciation_percent,
          original_gross_amount, previous_adjustment_amount, previous_final_amount,
          requested_extra_reduction, proposed_final_amount,
          guest_opinion, manager_note, evidence_images_json, is_urgent,
          status, requested_by, created_at
        )
        OUTPUT INSERTED.id
        VALUES (
          @negotiationCode, @chargeId, @bookingId, @accommodationId,
          @itemName, @quantity, @unitPrice, @compensationMode, @depreciationPercent,
          @originalGrossAmount, @previousAdjustmentAmount, @previousFinalAmount,
          @requestedExtraReduction, @proposedFinalAmount,
          @guestOpinion, @managerNote, @evidenceImagesJson, @isUrgent,
          'PENDING', @requestedBy, SYSDATETIME()
        );
      `);

    const newId = Number(insertRes.recordset[0].id);
    const createdRaw = await fetchNegotiationDetailRaw(tx, newId, currentUser);
    const mgrIds = await fetchPropertyManagerUserIds(tx, bookingRow.accommodation_id, currentUser.id);
    return { negotiation: mapNegotiationRow(createdRaw), managerUserIds: mgrIds };
  });

  emitCompensationEvent("compensation:negotiation-created", {
    negotiation,
    targetUserIds: managerUserIds,
  });

  const folio = await getCheckoutFolio(bId, currentUser);
  return { negotiation, folio };
}

async function listNegotiations(query = {}, currentUser = {}) {
  const pool = db.getDBPool();
  const scope = getAccommodationScope(currentUser, "a");

  const rawStatus = String(query.status || "ALL").trim().toUpperCase();
  const allowedFilterStatuses = ["ALL", ...NEGOTIATION_STATUSES];
  if (!allowedFilterStatuses.includes(rawStatus)) {
    throw validationError("Trạng thái bộ lọc thương lượng không hợp lệ.");
  }

  const accId = query.accommodationId ? parsePositiveInt(query.accommodationId) : null;
  const bookingId = query.bookingId ? parsePositiveInt(query.bookingId) : null;
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const page = Math.max(1, parsePositiveInt(query.page) || 1);
  const limit = Math.min(50, Math.max(1, parsePositiveInt(query.limit) || 20));
  const offset = (page - 1) * limit;

  const baseReq = pool.request();
  scope.inputs.forEach((inp) => baseReq.input(inp.name, inp.type, inp.value));
  baseReq.input("accId", sql.Int, accId);
  baseReq.input("bookingId", sql.BigInt, bookingId);
  baseReq.input("status", sql.VarChar(25), rawStatus);
  baseReq.input("q", sql.NVarChar(200), q ? `%${q}%` : null);
  baseReq.input("offset", sql.Int, offset);
  baseReq.input("limit", sql.Int, limit);

  const commonWhere = `
    ${scope.condition}
    AND (@accId IS NULL OR n.accommodation_id = @accId)
    AND (@bookingId IS NULL OR n.booking_id = @bookingId)
    AND (
      @q IS NULL
      OR n.negotiation_code LIKE @q
      OR b.booking_code LIKE @q
      OR b.contact_name LIKE @q
      OR n.item_name LIKE @q
      OR a.accommodation_name LIKE @q
    )
  `;

  const result = await baseReq.query(`
    SELECT
      n.*,
      CONVERT(VARCHAR(18), n.version, 1) AS version_token,
      b.booking_code,
      b.contact_name,
      b.contact_phone,
      a.accommodation_name,
      ru.full_name AS requested_by_name,
      vu.full_name AS reviewed_by_name
    FROM dbo.compensation_negotiations n
    JOIN dbo.bookings b ON b.id = n.booking_id
    JOIN dbo.accommodations a ON a.id = n.accommodation_id
    LEFT JOIN dbo.users ru ON ru.id = n.requested_by
    LEFT JOIN dbo.users vu ON vu.id = n.reviewed_by
    WHERE ${commonWhere}
      AND (@status = 'ALL' OR n.status = @status)
    ORDER BY
      CASE WHEN n.status = 'PENDING' THEN 0 ELSE 1 END,
      CASE WHEN n.status = 'PENDING' AND n.is_urgent = 1 THEN 0 ELSE 1 END,
      n.created_at DESC,
      n.id DESC
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;

    SELECT n.status, COUNT_BIG(*) AS cnt
    FROM dbo.compensation_negotiations n
    JOIN dbo.bookings b ON b.id = n.booking_id
    JOIN dbo.accommodations a ON a.id = n.accommodation_id
    WHERE ${commonWhere}
    GROUP BY n.status;
  `);

  const counts = {
    ALL: 0,
    PENDING: 0,
    APPROVED: 0,
    PARTIALLY_APPROVED: 0,
    REJECTED: 0,
    CANCELLED: 0,
  };
  for (const row of result.recordsets[1]) {
    counts[row.status] = Number(row.cnt || 0);
    counts.ALL += Number(row.cnt || 0);
  }

  const totalForStatus = rawStatus === "ALL" ? counts.ALL : counts[rawStatus] || 0;

  return {
    items: result.recordsets[0].map(mapNegotiationRow),
    counts,
    pagination: {
      page,
      limit,
      total: totalForStatus,
      totalPages: totalForStatus > 0 ? Math.ceil(totalForStatus / limit) : 0,
    },
  };
}

async function getNegotiationSummary(currentUser = {}) {
  const pool = db.getDBPool();
  const isAdmin = currentUser?.role === "ADMIN";
  const scope = getAccommodationScope(currentUser, "a");

  const req = pool.request();
  scope.inputs.forEach((inp) => req.input(inp.name, inp.type, inp.value));

  if (isAdmin) {
    const res = await req.query(`
      SELECT
        COUNT_BIG(*) AS pending_count,
        SUM(CASE WHEN n.is_urgent = 1 THEN 1 ELSE 0 END) AS urgent_pending_count
      FROM dbo.compensation_negotiations n
      JOIN dbo.accommodations a ON a.id = n.accommodation_id
      WHERE n.status = 'PENDING'
        AND ${scope.condition};

      SELECT TOP 6
        n.*,
        CONVERT(VARCHAR(18), n.version, 1) AS version_token,
        b.booking_code,
        b.contact_name,
        b.contact_phone,
        a.accommodation_name,
        ru.full_name AS requested_by_name,
        vu.full_name AS reviewed_by_name
      FROM dbo.compensation_negotiations n
      JOIN dbo.bookings b ON b.id = n.booking_id
      JOIN dbo.accommodations a ON a.id = n.accommodation_id
      LEFT JOIN dbo.users ru ON ru.id = n.requested_by
      LEFT JOIN dbo.users vu ON vu.id = n.reviewed_by
      WHERE n.status = 'PENDING'
        AND ${scope.condition}
      ORDER BY n.is_urgent DESC, n.created_at DESC, n.id DESC;
    `);
    const countsRow = res.recordsets[0][0] || {};
    return {
      role: "ADMIN",
      pendingCount: Number(countsRow.pending_count || 0),
      urgentPendingCount: Number(countsRow.urgent_pending_count || 0),
      unreadDecisionCount: 0,
      badgeCount: Number(countsRow.pending_count || 0),
      items: res.recordsets[1].map(mapNegotiationRow),
    };
  }

  const res = await req.query(`
    SELECT
      SUM(CASE WHEN n.status IN ('APPROVED', 'PARTIALLY_APPROVED', 'REJECTED') AND n.manager_ack_at IS NULL THEN 1 ELSE 0 END) AS unread_decision_count,
      SUM(CASE WHEN n.status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count
    FROM dbo.compensation_negotiations n
    JOIN dbo.accommodations a ON a.id = n.accommodation_id
    WHERE ${scope.condition};

    SELECT TOP 6
      n.*,
      CONVERT(VARCHAR(18), n.version, 1) AS version_token,
      b.booking_code,
      b.contact_name,
      b.contact_phone,
      a.accommodation_name,
      ru.full_name AS requested_by_name,
      vu.full_name AS reviewed_by_name
    FROM dbo.compensation_negotiations n
    JOIN dbo.bookings b ON b.id = n.booking_id
    JOIN dbo.accommodations a ON a.id = n.accommodation_id
    LEFT JOIN dbo.users ru ON ru.id = n.requested_by
    LEFT JOIN dbo.users vu ON vu.id = n.reviewed_by
    WHERE ${scope.condition}
      AND (
        (n.status IN ('APPROVED', 'PARTIALLY_APPROVED', 'REJECTED') AND n.manager_ack_at IS NULL)
        OR n.status = 'PENDING'
      )
    ORDER BY
      CASE WHEN n.manager_ack_at IS NULL AND n.status IN ('APPROVED', 'PARTIALLY_APPROVED', 'REJECTED') THEN 0 ELSE 1 END,
      COALESCE(n.reviewed_at, n.created_at) DESC,
      n.id DESC;
  `);
  const countsRow = res.recordsets[0][0] || {};
  const unreadDecisionCount = Number(countsRow.unread_decision_count || 0);
  const pendingCount = Number(countsRow.pending_count || 0);
  return {
    role: currentUser?.role || "ACCOMMODATION_MANAGER",
    pendingCount,
    urgentPendingCount: 0,
    unreadDecisionCount,
    badgeCount: unreadDecisionCount,
    items: res.recordsets[1].map(mapNegotiationRow),
  };
}

async function getNegotiationDetail(negotiationId, currentUser = {}) {
  const nId = parsePositiveInt(negotiationId);
  if (!nId) {
    throw validationError("Mã phiếu thương lượng không hợp lệ.");
  }

  const pool = db.getDBPool();
  const raw = await fetchNegotiationDetailRaw(pool, nId, currentUser);
  if (!raw) {
    throw new CheckoutSettlementError(
      404,
      ERROR_CODES.NOT_FOUND,
      "Không tìm thấy phiếu thương lượng bồi thường trong phạm vi quản lý.",
    );
  }
  return mapNegotiationRow(raw);
}

async function reviewNegotiationProposal(negotiationId, payload = {}, currentUser = {}) {
  if (currentUser?.role !== "ADMIN") {
    throw new CheckoutSettlementError(
      403,
      ERROR_CODES.FORBIDDEN,
      "Chỉ Quản trị viên cấp cao (Admin) mới có quyền kiểm tra và xác nhận kết quả thương lượng bồi thường.",
    );
  }

  const nId = parsePositiveInt(negotiationId);
  if (!nId) {
    throw validationError("Mã phiếu thương lượng không hợp lệ.");
  }

  const decision = String(payload.decision || "").trim().toUpperCase();
  const adminDecisionNote = String(payload.adminDecisionNote || "").trim();
  if (adminDecisionNote.length < 3 || adminDecisionNote.length > 1000) {
    throw validationError("Vui lòng nhập ghi chú phản hồi của Admin gửi về Manager (từ 3 đến 1.000 ký tự).", {
      adminDecisionNote: "Phản hồi của Admin phải từ 3 đến 1.000 ký tự.",
    });
  }

  const pool = db.getDBPool();

  const { negotiation, managerUserIds } = await runInTransaction(pool, async (tx) => {
    const raw = await fetchNegotiationDetailRaw(tx, nId, currentUser, { lock: true });
    if (!raw) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy phiếu thương lượng.");
    }
    if (raw.status !== "PENDING") {
      throw invalidStateError("Phiếu thương lượng này đã được xử lý trước đó.");
    }
    if (payload.versionToken && payload.versionToken !== raw.version_token) {
      throw invalidStateError("Phiếu thương lượng vừa thay đổi từ phiên khác. Vui lòng tải lại.");
    }

    const bookingRow = await fetchBookingCoreFixedSql(tx, Number(raw.booking_id), currentUser, { lock: true });
    const invoiceRow = bookingRow ? await fetchInvoiceRow(tx, Number(raw.booking_id), { lock: true }) : null;
    assertStayEditableForCharges(bookingRow, invoiceRow);

    const chargeRes = await new sql.Request(tx)
      .input("chargeId", sql.BigInt, Number(raw.charge_id))
      .query(`
        SELECT *
        FROM dbo.booking_incidental_charges WITH (UPDLOCK, HOLDLOCK)
        WHERE id = @chargeId;
      `);
    const charge = chargeRes.recordset[0];
    if (!charge || charge.status !== "ACTIVE") {
      throw invalidStateError("Khoản bồi thường gốc đã bị hủy, không thể phê duyệt phiếu thương lượng.");
    }

    const outcome = computeReviewOutcome({
      originalGrossAmount: Number(raw.original_gross_amount),
      previousAdjustmentAmount: Number(raw.previous_adjustment_amount),
      previousFinalAmount: Number(raw.previous_final_amount),
      requestedExtraReduction: Number(raw.requested_extra_reduction),
      decision,
      approvedExtraReduction: payload.approvedExtraReduction,
    });

    if (outcome.status === "APPROVED" || outcome.status === "PARTIALLY_APPROVED") {
      await cancelPendingOnlineSettlementsInTx(tx, Number(raw.booking_id));
      await new sql.Request(tx)
        .input("chargeId", sql.BigInt, Number(raw.charge_id))
        .input("adjustmentAmount", sql.Decimal(18, 0), outcome.nextAdjustmentAmount)
        .input("subtotalAmount", sql.Decimal(18, 0), outcome.nextTotalAmount)
        .input("totalAmount", sql.Decimal(18, 0), outcome.nextTotalAmount)
        .query(`
          UPDATE dbo.booking_incidental_charges
          SET
            adjustment_amount = @adjustmentAmount,
            subtotal_amount = @subtotalAmount,
            total_amount = @totalAmount,
            updated_at = SYSDATETIME()
          WHERE id = @chargeId;
        `);
    }

    await new sql.Request(tx)
      .input("negId", sql.BigInt, nId)
      .input("status", sql.VarChar(25), outcome.status)
      .input("approvedExtra", sql.Decimal(18, 0), outcome.approvedExtraReduction)
      .input("finalApproved", sql.Decimal(18, 0), outcome.finalApprovedAmount)
      .input("adminNote", sql.NVarChar(1000), adminDecisionNote)
      .input("reviewedBy", sql.UniqueIdentifier, currentUser.id)
      .query(`
        UPDATE dbo.compensation_negotiations
        SET
          status = @status,
          approved_extra_reduction = @approvedExtra,
          final_approved_amount = @finalApproved,
          admin_decision_note = @adminNote,
          reviewed_by = @reviewedBy,
          reviewed_at = SYSDATETIME(),
          manager_ack_at = NULL,
          updated_at = SYSDATETIME()
        WHERE id = @negId;
      `);

    const updatedRaw = await fetchNegotiationDetailRaw(tx, nId, currentUser);
    const mgrIds = await fetchPropertyManagerUserIds(tx, raw.accommodation_id, raw.requested_by);
    return { negotiation: mapNegotiationRow(updatedRaw), managerUserIds: mgrIds };
  });

  emitCompensationEvent("compensation:negotiation-reviewed", {
    negotiation,
    targetUserIds: managerUserIds,
  });

  const folio = await getCheckoutFolio(negotiation.bookingId, currentUser);
  return { negotiation, folio };
}

async function cancelNegotiationProposal(negotiationId, currentUser = {}) {
  const nId = parsePositiveInt(negotiationId);
  if (!nId) {
    throw validationError("Mã phiếu thương lượng không hợp lệ.");
  }

  const pool = db.getDBPool();
  const { negotiation, managerUserIds } = await runInTransaction(pool, async (tx) => {
    const raw = await fetchNegotiationDetailRaw(tx, nId, currentUser, { lock: true });
    if (!raw) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy phiếu thương lượng.");
    }
    if (raw.status !== "PENDING") {
      throw invalidStateError("Chỉ có thể hủy phiếu thương lượng đang ở trạng thái chờ duyệt.");
    }

    await new sql.Request(tx)
      .input("negId", sql.BigInt, nId)
      .query(`
        UPDATE dbo.compensation_negotiations
        SET status = 'CANCELLED', updated_at = SYSDATETIME()
        WHERE id = @negId;
      `);

    const updatedRaw = await fetchNegotiationDetailRaw(tx, nId, currentUser);
    const mgrIds = await fetchPropertyManagerUserIds(tx, raw.accommodation_id, raw.requested_by);
    return { negotiation: mapNegotiationRow(updatedRaw), managerUserIds: mgrIds };
  });

  emitCompensationEvent("compensation:negotiation-cancelled", {
    negotiation,
    targetUserIds: managerUserIds,
  });

  const folio = await getCheckoutFolio(negotiation.bookingId, currentUser);
  return { negotiation, folio };
}

async function acknowledgeNegotiationDecision(negotiationId, currentUser = {}) {
  const nId = parsePositiveInt(negotiationId);
  if (!nId) {
    throw validationError("Mã phiếu thương lượng không hợp lệ.");
  }

  const pool = db.getDBPool();
  const updated = await runInTransaction(pool, async (tx) => {
    const raw = await fetchNegotiationDetailRaw(tx, nId, currentUser, { lock: true });
    if (!raw) {
      throw new CheckoutSettlementError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy phiếu thương lượng.");
    }
    if (!["APPROVED", "PARTIALLY_APPROVED", "REJECTED"].includes(raw.status)) {
      return mapNegotiationRow(raw);
    }

    if (!raw.manager_ack_at) {
      await new sql.Request(tx)
        .input("negId", sql.BigInt, nId)
        .query(`
          UPDATE dbo.compensation_negotiations
          SET manager_ack_at = SYSDATETIME(), updated_at = SYSDATETIME()
          WHERE id = @negId AND manager_ack_at IS NULL;
        `);
    }

    const updatedRaw = await fetchNegotiationDetailRaw(tx, nId, currentUser);
    return mapNegotiationRow(updatedRaw);
  });

  return { negotiation: updated };
}

module.exports = {
  NEGOTIATION_STATUSES,
  MAX_EVIDENCE_IMAGES,
  sanitizeEvidenceImages,
  computeProposalSnapshot,
  computeReviewOutcome,
  createNegotiationProposal,
  listNegotiations,
  getNegotiationSummary,
  getNegotiationDetail,
  reviewNegotiationProposal,
  cancelNegotiationProposal,
  acknowledgeNegotiationDecision,
};
