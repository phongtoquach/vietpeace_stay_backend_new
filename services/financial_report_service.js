const sql = require("mssql");
const { getDBPool } = require("../configs/database");
const { ERROR_CODES } = require("../constants/error_codes");
const {
  getAccommodationScope,
  assertAccommodationAccess,
  isAdminUser,
} = require("./accommodation_access_service");
const mailService = require("./mail_service");

class FinancialReportError extends Error {
  constructor(statusCode, errorCode, message, errors = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errors = errors;
  }
}

function toNumber(val, fallback = 0) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function roundVnd(val) {
  return Math.round(toNumber(val, 0));
}

function formatDateYmd(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getCurrentCalendarYear() {
  return new Date().getFullYear();
}

/**
 * Normalize query/body period parameters into concrete half-open UTC date range
 * and enumerable (year, month) buckets.
 */
function normalizePeriodFilters(filters = {}) {
  const rawYear = filters.year ?? getCurrentCalendarYear();
  const year = Number(rawYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new FinancialReportError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "Năm báo cáo phải là số nguyên từ 2000 đến 2100.",
    );
  }

  let periodType = String(filters.periodType || "").trim().toUpperCase();
  const rawMonth =
    filters.month !== undefined && filters.month !== null && filters.month !== ""
      ? Number(filters.month)
      : null;
  const rawQuarter =
    filters.quarter !== undefined && filters.quarter !== null && filters.quarter !== ""
      ? Number(filters.quarter)
      : null;

  if (!periodType) {
    if (rawMonth !== null) periodType = "MONTH";
    else if (rawQuarter !== null) periodType = "QUARTER";
    else periodType = "YEAR";
  }

  if (!["YEAR", "QUARTER", "MONTH"].includes(periodType)) {
    throw new FinancialReportError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "periodType chỉ hỗ trợ YEAR, QUARTER hoặc MONTH.",
    );
  }

  let quarter = 0;
  let month = 0;
  let months = [];
  let periodStart;
  let periodEnd;
  let periodLabel;

  if (periodType === "MONTH") {
    const m = rawMonth ?? (new Date().getMonth() + 1);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      throw new FinancialReportError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        "Tháng báo cáo phải nằm trong khoảng 1..12.",
      );
    }
    month = m;
    months = [m];
    periodStart = new Date(Date.UTC(year, m - 1, 1, 0, 0, 0));
    periodEnd = new Date(Date.UTC(year, m, 1, 0, 0, 0));
    periodLabel = `Tháng ${String(m).padStart(2, "0")}/${year}`;
  } else if (periodType === "QUARTER") {
    const q = rawQuarter ?? Math.floor(new Date().getMonth() / 3) + 1;
    if (!Number.isInteger(q) || q < 1 || q > 4) {
      throw new FinancialReportError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        "Quý báo cáo phải nằm trong khoảng 1..4.",
      );
    }
    quarter = q;
    const startMonth = (q - 1) * 3 + 1;
    months = [startMonth, startMonth + 1, startMonth + 2];
    periodStart = new Date(Date.UTC(year, startMonth - 1, 1, 0, 0, 0));
    periodEnd = new Date(Date.UTC(year, startMonth + 2, 1, 0, 0, 0));
    periodLabel = `Quý ${q}/${year}`;
  } else {
    months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    periodStart = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    periodEnd = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));
    periodLabel = `Cả năm ${year}`;
  }

  return {
    year,
    periodType,
    quarter,
    month,
    months,
    periodStart,
    periodEnd,
    periodStartStr: formatDateYmd(periodStart),
    periodEndStr: formatDateYmd(periodEnd),
    periodLabel,
  };
}

/**
 * Compute overlapping nights between [checkIn, checkOut) and [rangeStart, rangeEnd)
 */
function computeOverlapNights(checkInDate, checkOutDate, rangeStart, rangeEnd) {
  const ci = checkInDate instanceof Date ? checkInDate : new Date(checkInDate);
  const co = checkOutDate instanceof Date ? checkOutDate : new Date(checkOutDate);
  const startMs = Math.max(
    Date.UTC(ci.getUTCFullYear(), ci.getUTCMonth(), ci.getUTCDate()),
    Date.UTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), rangeStart.getUTCDate()),
  );
  const endMs = Math.min(
    Date.UTC(co.getUTCFullYear(), co.getUTCMonth(), co.getUTCDate()),
    Date.UTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), rangeEnd.getUTCDate()),
  );
  if (endMs <= startMs) return 0;
  return Math.round((endMs - startMs) / 86400000);
}

/**
 * Pure P&L accumulator for a single accommodation over the requested period months.
 * Uses Case A (ledger row present) before Case B (operating profile fallback after opex_start_date).
 */
function computePropertyPnl({
  property,
  profile,
  months,
  year,
  ledgersByMonth = new Map(),
  bookingPaymentAgg = {},
  soldNightsByMonth = new Map(),
  paidBookingsByMonth = new Map(),
  asOfDate = new Date(),
}) {
  const opexStartRaw = profile?.opex_start_date
    ? new Date(profile.opex_start_date)
    : new Date(Date.UTC(2026, 0, 1));
  const opexStartMonthEnd = new Date(
    Date.UTC(opexStartRaw.getUTCFullYear(), opexStartRaw.getUTCMonth(), opexStartRaw.getUTCDate()),
  );

  // Current real calendar month boundary (avoids counting unstarted future months in Case B fallback)
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;
  const asOfMonthIndex = asOfYear * 12 + asOfMonth;

  let ancillaryServiceRevenue = 0;
  let otherRentalRevenue = 0;

  let electricityCost = 0;
  let waterCost = 0;
  let internetFuelCost = 0;
  let assetDepreciationCost = 0;
  let maintenanceRepairCost = 0;
  let managerSalaryCost = 0;
  let staffPayrollCost = 0;
  let otherOperatingCost = 0;

  let ledgerMonthsCount = 0;
  let fallbackMonthsCount = 0;
  let operatingMonthsCount = 0;

  const monthlyBreakdown = [];

  for (const m of months) {
    const ledger = ledgersByMonth.get(m);
    const soldNights = toNumber(soldNightsByMonth.get(m), 0);
    const hasBookingActivity = toNumber(paidBookingsByMonth.get(m), 0) > 0 || soldNights > 0;
    const monthEnd = new Date(Date.UTC(year, m, 0));
    const monthIndex = year * 12 + m;

    let monthSource = "NOT_STARTED";
    let mAncillary = 0;
    let mRental = 0;
    let mElec = 0;
    let mWater = 0;
    let mInternet = 0;
    let mDepr = 0;
    let mMaint = 0;
    let mMgrSal = 0;
    let mStaffSal = 0;
    let mOther = 0;

    if (ledger) {
      monthSource = "LEDGER";
      ledgerMonthsCount += 1;
      operatingMonthsCount += 1;
      mAncillary = toNumber(ledger.ancillary_service_revenue);
      mRental = toNumber(ledger.other_rental_revenue);
      mElec = toNumber(ledger.electricity_cost);
      mWater = toNumber(ledger.water_cost);
      mInternet = toNumber(ledger.internet_fuel_cost);
      mDepr = toNumber(ledger.asset_depreciation_cost);
      mMaint = toNumber(ledger.maintenance_repair_cost);
      mMgrSal = toNumber(ledger.manager_salary_cost);
      mStaffSal = toNumber(ledger.staff_payroll_cost);
      mOther = toNumber(ledger.other_operating_cost);
    } else if (profile && ((monthEnd >= opexStartMonthEnd && monthIndex <= asOfMonthIndex) || hasBookingActivity)) {
      monthSource = "PROFILE_FALLBACK";
      fallbackMonthsCount += 1;
      operatingMonthsCount += 1;
      const varUtil = soldNights * toNumber(profile.variable_utility_per_room_night);
      mElec = roundVnd(toNumber(profile.base_electricity_cost) + varUtil * 0.72);
      mWater = roundVnd(toNumber(profile.base_water_cost) + varUtil * 0.28);
      mInternet = toNumber(profile.internet_fuel_cost);
      mDepr = toNumber(profile.monthly_asset_depreciation);
      mMaint = toNumber(profile.monthly_maintenance_supplies);
      mMgrSal = toNumber(profile.manager_base_salary);
      mStaffSal = toNumber(profile.staff_monthly_payroll);
      mOther = toNumber(profile.other_fixed_opex);
    }

    ancillaryServiceRevenue += mAncillary;
    otherRentalRevenue += mRental;
    electricityCost += mElec;
    waterCost += mWater;
    internetFuelCost += mInternet;
    assetDepreciationCost += mDepr;
    maintenanceRepairCost += mMaint;
    managerSalaryCost += mMgrSal;
    staffPayrollCost += mStaffSal;
    otherOperatingCost += mOther;

    const monthOpex =
      mElec + mWater + mInternet + mDepr + mMaint + mMgrSal + mStaffSal + mOther;

    monthlyBreakdown.push({
      year,
      month: m,
      source: monthSource,
      is_locked: Boolean(ledger?.is_locked),
      sold_room_nights: soldNights,
      ancillary_service_revenue: mAncillary,
      other_rental_revenue: mRental,
      extra_facility_revenue: mAncillary + mRental,
      electricity_cost: mElec,
      water_cost: mWater,
      internet_fuel_cost: mInternet,
      asset_depreciation_cost: mDepr,
      maintenance_repair_cost: mMaint,
      manager_salary_cost: mMgrSal,
      staff_payroll_cost: mStaffSal,
      other_operating_cost: mOther,
      total_expenses: monthOpex,
      note: ledger?.note || null,
    });
  }

  const grossCashCollected = toNumber(bookingPaymentAgg.gross_cash_collected);
  const bookingTaxCollected = toNumber(bookingPaymentAgg.booking_tax_collected);
  const netBookingRevenuePreVat = grossCashCollected - bookingTaxCollected;
  const extraFacilityRevenue = ancillaryServiceRevenue + otherRentalRevenue;
  const totalNetRevenue = netBookingRevenuePreVat + extraFacilityRevenue;
  const grossCashPlusFacility = grossCashCollected + extraFacilityRevenue;

  const totalExpenses =
    electricityCost +
    waterCost +
    internetFuelCost +
    assetDepreciationCost +
    maintenanceRepairCost +
    managerSalaryCost +
    staffPayrollCost +
    otherOperatingCost;

  const ebt = totalNetRevenue - totalExpenses;
  const taxRatePercent = toNumber(profile?.tax_rate_percent, 10);
  const taxAmount = ebt > 0 ? roundVnd(ebt * (taxRatePercent / 100)) : 0;
  const netProfitAfterTax = ebt - taxAmount;
  const netMarginPercent =
    totalNetRevenue > 0
      ? Number(((netProfitAfterTax / totalNetRevenue) * 100).toFixed(2))
      : 0;

  const monthlyTargetNetProfit = toNumber(profile?.monthly_target_net_profit, 50000000);
  const activeMonthsForKpi = Math.max(1, operatingMonthsCount);
  const periodKpiTarget = monthlyTargetNetProfit * activeMonthsForKpi;
  const kpiProgressPercent =
    periodKpiTarget > 0
      ? Number(((netProfitAfterTax / periodKpiTarget) * 100).toFixed(1))
      : 0;

  return {
    accommodation_id: Number(property.id),
    accommodation_code: property.accommodation_code,
    accommodation_name: property.accommodation_name,
    accommodation_type_id: Number(property.accommodation_type_id),
    accommodation_type_name: property.accommodation_type_name,
    location_id: Number(property.location_id),
    location_name: property.location_name,
    total_rooms: toNumber(property.total_rooms),
    manager_user_id: property.manager_user_id || null,
    manager_name: property.manager_name || null,
    manager_email: property.manager_personal_email || property.manager_internal_email || null,
    manager_personal_email: property.manager_personal_email || null,
    manager_internal_email: property.manager_internal_email || null,
    assigned_at: property.assigned_at || null,
    days_since_assigned:
      property.assigned_at
        ? Math.max(0, Math.floor((asOfDate - new Date(property.assigned_at)) / 86400000))
        : null,
    is_new_manager_under_30_days:
      property.assigned_at
        ? Math.floor((asOfDate - new Date(property.assigned_at)) / 86400000) < 30
        : false,

    booking_count: toNumber(bookingPaymentAgg.booking_count),
    paid_transaction_count: toNumber(bookingPaymentAgg.paid_transaction_count),
    sold_room_nights: [...soldNightsByMonth.values()].reduce((s, n) => s + toNumber(n), 0),

    rooms_subtotal: toNumber(bookingPaymentAgg.rooms_subtotal),
    extra_guest_total: toNumber(bookingPaymentAgg.extra_guest_total),
    service_fee: toNumber(bookingPaymentAgg.service_fee),
    discounts: toNumber(bookingPaymentAgg.discounts),
    cancellation_retained_fee: toNumber(bookingPaymentAgg.cancellation_retained_fee),
    refunded_amount: toNumber(bookingPaymentAgg.refunded_amount),
    pending_refund_amount: toNumber(bookingPaymentAgg.pending_refund_amount),

    gross_cash_collected: grossCashCollected,
    booking_tax_collected: bookingTaxCollected,
    net_booking_revenue_pre_vat: netBookingRevenuePreVat,
    ancillary_service_revenue: ancillaryServiceRevenue,
    other_rental_revenue: otherRentalRevenue,
    extra_facility_revenue: extraFacilityRevenue,
    total_net_revenue: totalNetRevenue,
    gross_cash_plus_facility: grossCashPlusFacility,

    expenses: {
      electricity_cost: electricityCost,
      water_cost: waterCost,
      utilities_total: electricityCost + waterCost,
      internet_fuel_cost: internetFuelCost,
      asset_depreciation_cost: assetDepreciationCost,
      maintenance_repair_cost: maintenanceRepairCost,
      manager_salary_cost: managerSalaryCost,
      staff_payroll_cost: staffPayrollCost,
      payroll_total: managerSalaryCost + staffPayrollCost,
      other_operating_cost: otherOperatingCost,
    },
    total_expenses: totalExpenses,
    ebt,
    tax_rate_percent: taxRatePercent,
    tax_amount: taxAmount,
    net_profit_after_tax: netProfitAfterTax,
    net_margin_percent: netMarginPercent,

    monthly_target_net_profit: monthlyTargetNetProfit,
    period_kpi_target: periodKpiTarget,
    kpi_progress_percent: kpiProgressPercent,
    operating_months_count: operatingMonthsCount,
    ledger_months_count: ledgerMonthsCount,
    fallback_months_count: fallbackMonthsCount,
    data_source_mode:
      ledgerMonthsCount > 0 && fallbackMonthsCount === 0
        ? "LEDGER"
        : ledgerMonthsCount > 0
          ? "MIXED"
          : operatingMonthsCount > 0
            ? "PROFILE_FALLBACK"
            : "NOT_STARTED",

    profile: profile
      ? {
          staff_headcount: toNumber(profile.staff_headcount),
          manager_base_salary: toNumber(profile.manager_base_salary),
          staff_avg_salary: toNumber(profile.staff_avg_salary),
          staff_monthly_payroll: toNumber(profile.staff_monthly_payroll),
          base_electricity_cost: toNumber(profile.base_electricity_cost),
          base_water_cost: toNumber(profile.base_water_cost),
          variable_utility_per_room_night: toNumber(profile.variable_utility_per_room_night),
          internet_fuel_cost: toNumber(profile.internet_fuel_cost),
          monthly_asset_depreciation: toNumber(profile.monthly_asset_depreciation),
          monthly_maintenance_supplies: toNumber(profile.monthly_maintenance_supplies),
          other_fixed_opex: toNumber(profile.other_fixed_opex),
          tax_rate_percent: toNumber(profile.tax_rate_percent),
          monthly_target_net_profit: toNumber(profile.monthly_target_net_profit),
          opex_start_date: formatDateYmd(profile.opex_start_date),
        }
      : null,

    monthly_breakdown: monthlyBreakdown,
  };
}

function compareByProfitTieBreak(a, b) {
  if (b.net_profit_after_tax !== a.net_profit_after_tax) {
    return b.net_profit_after_tax - a.net_profit_after_tax;
  }
  if (b.net_margin_percent !== a.net_margin_percent) {
    return b.net_margin_percent - a.net_margin_percent;
  }
  if (b.total_net_revenue !== a.total_net_revenue) {
    return b.total_net_revenue - a.total_net_revenue;
  }
  return a.accommodation_id - b.accommodation_id;
}

/**
 * Rank and classify properties into TOP_1, TOP_2, TOP_3, PROFITABLE, LOW_OR_ZERO, NEGATIVE_LOSS.
 * Supports rankingMode: 'CHAIN' | 'BY_TYPE'.
 */
function classifyAndRankProperties(rows, options = {}) {
  const rankingMode = String(options.rankingMode || "CHAIN").toUpperCase() === "BY_TYPE"
    ? "BY_TYPE"
    : "CHAIN";
  const sortBy = String(options.sortBy || "net_profit").toLowerCase();

  // Group into ranking buckets ('ALL' for CHAIN, or accommodation_type_id for BY_TYPE)
  const buckets = new Map();
  for (const row of rows) {
    const key = rankingMode === "BY_TYPE" ? String(row.accommodation_type_id) : "ALL";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  const enriched = [];

  for (const [, bucketRows] of buckets.entries()) {
    const sorted = [...bucketRows].sort(compareByProfitTieBreak);
    let positiveRank = 0;

    for (const row of sorted) {
      let rank = null;
      let tier;
      let bonusRatePercent = 0;

      if (row.net_profit_after_tax > 0) {
        positiveRank += 1;
        rank = positiveRank;

        if (rank === 1) {
          tier = "TOP_1";
          bonusRatePercent = 3.0;
        } else if (rank === 2) {
          tier = "TOP_2";
          bonusRatePercent = 2.0;
        } else if (rank === 3) {
          tier = "TOP_3";
          bonusRatePercent = 1.0;
        } else if (row.net_margin_percent < 5) {
          tier = "LOW_OR_ZERO";
          bonusRatePercent = 0;
        } else {
          tier = "PROFITABLE";
          bonusRatePercent = row.net_profit_after_tax >= row.period_kpi_target ? 0.5 : 0;
        }
      } else if (row.net_profit_after_tax < 0) {
        tier = "NEGATIVE_LOSS";
        bonusRatePercent = 0;
      } else {
        // net_profit_after_tax === 0
        tier = "LOW_OR_ZERO";
        bonusRatePercent = 0;
      }

      const topBonusAmount =
        bonusRatePercent > 0 && row.net_profit_after_tax > 0
          ? roundVnd(row.net_profit_after_tax * (bonusRatePercent / 100))
          : 0;

      enriched.push({
        ...row,
        ranking_mode: rankingMode,
        ranking_position: rank,
        performance_tier: tier,
        top_bonus_rate_percent: bonusRatePercent,
        top_bonus_amount: topBonusAmount,
      });
    }
  }

  if (sortBy === "net_margin") {
    enriched.sort((a, b) => {
      if (b.net_margin_percent !== a.net_margin_percent) {
        return b.net_margin_percent - a.net_margin_percent;
      }
      return compareByProfitTieBreak(a, b);
    });
  } else {
    enriched.sort(compareByProfitTieBreak);
  }

  return enriched;
}

/**
 * Calculate Manager working months default inside a calendar year (0..12) from assigned_at.
 */
function inferManagerWorkingMonths(assignedAt, periodYear, asOfDate = new Date()) {
  if (!assignedAt) return 0;
  const dt = new Date(assignedAt);
  if (Number.isNaN(dt.getTime())) return 12;

  const assignedYear = dt.getUTCFullYear();
  const assignedMonth = dt.getUTCMonth() + 1;
  const maxMonthInYear =
    periodYear < asOfDate.getUTCFullYear()
      ? 12
      : periodYear > asOfDate.getUTCFullYear()
        ? 0
        : Math.max(1, asOfDate.getUTCMonth() + 1);

  if (assignedYear < periodYear) return Math.min(12, Math.max(1, maxMonthInYear));
  if (assignedYear > periodYear) return 0;
  // Prorated from assigned month through December (or active operating period of the year)
  const worked = 12 - assignedMonth + 1;
  return Math.max(1, Math.min(12, worked));
}

/**
 * Pure Bonus, 13th-Month Salary & Tet Reward settlement calculator (Section 3.3).
 */
function calculateBonusSettlementRow({
  rankedProperty,
  settlementType = "ANNUAL_TET_13TH",
  periodYear,
  priorApprovedTopBonusDeducted = 0,
  managerWorkingMonthsOverride = null,
  managerCsPenaltyFactor = 1.0,
  existingSettlement = null,
  asOfDate = new Date(),
}) {
  const hasManager = Boolean(rankedProperty.manager_user_id);
  const profile = rankedProperty.profile || {};
  const managerBaseSalary = toNumber(profile.manager_base_salary);
  const staffHeadcount = Math.max(0, toNumber(profile.staff_headcount));
  const staffMonthlyPayroll = toNumber(profile.staff_monthly_payroll);

  const defaultWorkingMonths = hasManager
    ? inferManagerWorkingMonths(rankedProperty.assigned_at, periodYear, asOfDate)
    : 0;
  const workingMonthsRaw =
    managerWorkingMonthsOverride !== null && managerWorkingMonthsOverride !== undefined
      ? Number(managerWorkingMonthsOverride)
      : existingSettlement?.manager_working_months !== undefined &&
          existingSettlement?.manager_working_months !== null
        ? Number(existingSettlement.manager_working_months)
        : defaultWorkingMonths;
  const managerWorkingMonths = hasManager
    ? Math.max(0, Math.min(12, Math.trunc(workingMonthsRaw || 0)))
    : 0;

  const isAnnual = settlementType === "ANNUAL_TET_13TH";
  const staffOperatingMonths = isAnnual
    ? Math.max(1, Math.min(12, toNumber(rankedProperty.operating_months_count, 11)))
    : 0;

  const manager13thSalary =
    hasManager && isAnnual
      ? roundVnd(managerBaseSalary * (managerWorkingMonths / 12))
      : 0;
  const staff13thSalaryPool = isAnnual
    ? roundVnd(staffMonthlyPayroll * (staffOperatingMonths / 12))
    : 0;

  const netProfit = toNumber(rankedProperty.net_profit_after_tax);
  const eligibleForBonus =
    netProfit > 0 &&
    ["TOP_1", "TOP_2", "TOP_3", "PROFITABLE"].includes(rankedProperty.performance_tier) &&
    toNumber(rankedProperty.top_bonus_amount) > 0;

  const baseBonusPool = eligibleForBonus ? toNumber(rankedProperty.top_bonus_amount) : 0;

  const annualKpiTarget = toNumber(rankedProperty.period_kpi_target);
  const propertyKpiMultiplier =
    isAnnual && eligibleForBonus && netProfit >= annualKpiTarget ? 1.2 : 1.0;
  const grossBonusPool = roundVnd(baseBonusPool * propertyKpiMultiplier);

  const priorDeducted = isAnnual ? Math.max(0, toNumber(priorApprovedTopBonusDeducted)) : 0;
  const netDistributableBonusPool = Math.max(0, grossBonusPool - priorDeducted);

  // Split strictly: 60% Staff (never penalized for Manager's personal violation), 40% Manager
  const staffTetBonusPool = roundVnd(netDistributableBonusPool * 0.6);
  const managerRawBonus = netDistributableBonusPool - staffTetBonusPool;
  const csFactor = hasManager ? Number(managerCsPenaltyFactor || 1.0) : 1.0;
  const managerTetBonus = hasManager ? roundVnd(managerRawBonus * csFactor) : 0;

  const totalPayoutAmount =
    manager13thSalary + managerTetBonus + staff13thSalaryPool + staffTetBonusPool;
  const staffCombinedPayout = staff13thSalaryPool + staffTetBonusPool;
  const avgStaffPayout =
    staffHeadcount > 0 ? roundVnd(staffCombinedPayout / staffHeadcount) : 0;

  return {
    accommodation_id: rankedProperty.accommodation_id,
    accommodation_code: rankedProperty.accommodation_code,
    accommodation_name: rankedProperty.accommodation_name,
    accommodation_type_name: rankedProperty.accommodation_type_name,
    location_name: rankedProperty.location_name,
    manager_user_id: rankedProperty.manager_user_id,
    manager_name: rankedProperty.manager_name,
    manager_personal_email: rankedProperty.manager_personal_email,
    manager_base_salary: managerBaseSalary,
    assigned_at: rankedProperty.assigned_at,

    total_revenue: rankedProperty.total_net_revenue,
    total_expenses: rankedProperty.total_expenses,
    tax_amount: rankedProperty.tax_amount,
    net_profit_after_tax: netProfit,
    net_margin_percent: rankedProperty.net_margin_percent,
    period_kpi_target: annualKpiTarget,

    ranking_position: rankedProperty.ranking_position,
    performance_tier: rankedProperty.performance_tier,
    top_bonus_rate_percent: rankedProperty.top_bonus_rate_percent,
    top_bonus_amount: baseBonusPool,
    property_kpi_multiplier: propertyKpiMultiplier,
    gross_bonus_before_deduction: grossBonusPool,
    prior_period_top_bonus_deducted: priorDeducted,
    net_distributable_bonus_pool: netDistributableBonusPool,
    manager_cs_penalty_factor: csFactor,

    manager_working_months: managerWorkingMonths,
    default_working_months: defaultWorkingMonths,
    manager_13th_salary: manager13thSalary,
    manager_tet_bonus: managerTetBonus,
    staff_headcount: staffHeadcount,
    staff_operating_months: staffOperatingMonths,
    staff_monthly_payroll: staffMonthlyPayroll,
    staff_13th_salary_pool: staff13thSalaryPool,
    staff_tet_bonus_pool: staffTetBonusPool,
    avg_staff_payout: avgStaffPayout,
    total_payout_amount: totalPayoutAmount,

    settlement_id: existingSettlement?.id || null,
    settlement_status: existingSettlement?.status || "DRAFT",
    email_notification_status:
      existingSettlement?.email_notification_status ||
      (hasManager ? "NOT_SENT" : "SKIPPED_NO_MANAGER"),
    email_sent_at: existingSettlement?.email_sent_at || null,
    approved_at: existingSettlement?.approved_at || null,
    admin_note: existingSettlement?.admin_note || null,
  };
}

/**
 * Shared DB loader returning raw property P&L dataset for a period.
 * Computes chain-wide / per-type rankings first before applying display filters so ranks never drift.
 */
async function loadAndComputeFinancialRows(filters = {}, actor = {}) {
  const pool = getDBPool();
  const period = normalizePeriodFilters(filters);
  const rankingMode =
    String(filters.rankingMode || "CHAIN").toUpperCase() === "BY_TYPE" ? "BY_TYPE" : "CHAIN";
  const sortBy = String(filters.sortBy || "net_profit").toLowerCase();
  const isAdmin = isAdminUser(actor);
  const scope = getAccommodationScope(actor, "a");

  // 1. Fetch accommodations within RBAC scope + operating profiles + current active manager
  const accReq = pool.request();
  for (const inp of scope.inputs) accReq.input(inp.name, inp.type, inp.value);

  const accSql = `
    SELECT
      a.id,
      a.accommodation_code,
      a.accommodation_name,
      a.accommodation_type_id,
      at.name AS accommodation_type_name,
      a.location_id,
      loc.name AS location_name,
      ISNULL(rtAgg.total_rooms, 0) AS total_rooms,
      am.user_id AS manager_user_id,
      am.assigned_at,
      mgr.full_name AS manager_name,
      mgr.personal_email AS manager_personal_email,
      mgr.email AS manager_internal_email
    FROM dbo.accommodations a
    JOIN dbo.accommodation_types at ON at.id = a.accommodation_type_id
    JOIN dbo.locations loc ON loc.id = a.location_id
    LEFT JOIN (
      SELECT accommodation_id, SUM(quantity) AS total_rooms
      FROM dbo.room_types
      WHERE deleted_at IS NULL AND status = 1
      GROUP BY accommodation_id
    ) rtAgg ON rtAgg.accommodation_id = a.id
    LEFT JOIN dbo.accommodation_managers am ON am.accommodation_id = a.id
    LEFT JOIN dbo.users mgr ON mgr.id = am.user_id
    WHERE a.deleted_at IS NULL
      AND ${scope.condition}
    ORDER BY a.id ASC;
  `;

  // 2. Fetch profiles + monthly ledgers for period.year + payments + room nights + recent warnings
  const profReq = pool.request();
  const ledgReq = pool.request().input("year", sql.Int, period.year);
  const payReq = pool
    .request()
    .input("periodStart", sql.DateTime2, period.periodStart)
    .input("periodEnd", sql.DateTime2, period.periodEnd);
  const pendingRefReq = pool
    .request()
    .input("periodStart", sql.DateTime2, period.periodStart)
    .input("periodEnd", sql.DateTime2, period.periodEnd);
  const nightsReq = pool
    .request()
    .input("yearStart", sql.Date, `${period.year}-01-01`)
    .input("yearEnd", sql.Date, `${period.year + 1}-01-01`)
    .input("periodStart", sql.DateTime2, period.periodStart)
    .input("periodEnd", sql.DateTime2, period.periodEnd);
  const warnReq = pool.request();

  const [accRes, profRes, ledgRes, payRes, pendingRefRes, nightsRes, warnRes] = await Promise.all([
    accReq.query(accSql),
    profReq.query(`SELECT * FROM dbo.accommodation_operating_profiles;`),
    ledgReq.query(`
      SELECT *
      FROM dbo.accommodation_monthly_ledgers
      WHERE period_year = @year;
    `),
    payReq.query(`
      SELECT
        b.accommodation_id,
        b.id AS booking_id,
        b.status AS booking_status,
        b.rooms_subtotal,
        b.extra_guest_total,
        b.service_fee,
        b.room_discount_total,
        b.discount_amount,
        b.tax_amount,
        p.status AS payment_status,
        p.amount AS payment_amount,
        p.refunded_amount,
        p.paid_at
      FROM dbo.payments p
      JOIN dbo.bookings b ON b.id = p.booking_id
      WHERE p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED')
        AND p.paid_at >= @periodStart
        AND p.paid_at < @periodEnd;
    `),
    pendingRefReq.query(`
      SELECT
        b.accommodation_id,
        SUM(p.amount) AS pending_refund_amount
      FROM dbo.payments p
      JOIN dbo.bookings b ON b.id = p.booking_id
      WHERE p.status = 'REFUND_PROCESSING'
        AND ISNULL(p.paid_at, p.created_at) >= @periodStart
        AND ISNULL(p.paid_at, p.created_at) < @periodEnd
      GROUP BY b.accommodation_id;
    `),
    nightsReq.query(`
      SELECT
        b.accommodation_id,
        b.id AS booking_id,
        b.check_in_date,
        b.check_out_date,
        b.total_rooms
      FROM dbo.bookings b
      WHERE b.status = 'CONFIRMED'
        AND b.check_in_date < @yearEnd
        AND b.check_out_date > @yearStart
        AND EXISTS (
          SELECT 1
          FROM dbo.payments p
          WHERE p.booking_id = b.id
            AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED')
            AND p.paid_at >= @periodStart
            AND p.paid_at < @periodEnd
        );
    `),
    warnReq.query(`
      SELECT w.*
      FROM dbo.accommodation_financial_warnings w
      INNER JOIN (
        SELECT accommodation_id, MAX(id) AS max_id
        FROM dbo.accommodation_financial_warnings
        GROUP BY accommodation_id
      ) latest ON latest.max_id = w.id;
    `),
  ]);

  const profileMap = new Map();
  for (const p of profRes.recordset) profileMap.set(Number(p.accommodation_id), p);

  const ledgerMap = new Map(); // accId -> Map(month -> ledgerRow)
  for (const l of ledgRes.recordset) {
    const accId = Number(l.accommodation_id);
    if (!ledgerMap.has(accId)) ledgerMap.set(accId, new Map());
    ledgerMap.get(accId).set(Number(l.period_month), l);
  }

  // Group payment aggregates per accommodation & per month (for monthly chart & Case B triggers)
  const payAggMap = new Map();
  const paidBookingsByAccMonth = new Map();
  const monthlyPaymentSeries = Array.from({ length: 12 }, (_, idx) => ({
    month: idx + 1,
    netBookingRevenuePreVat: 0,
    grossCashCollected: 0,
    bookingTaxCollected: 0,
  }));

  for (const row of payRes.recordset) {
    const accId = Number(row.accommodation_id);
    if (!payAggMap.has(accId)) {
      payAggMap.set(accId, {
        bookingIds: new Set(),
        paid_transaction_count: 0,
        gross_cash_collected: 0,
        booking_tax_collected: 0,
        rooms_subtotal: 0,
        extra_guest_total: 0,
        service_fee: 0,
        discounts: 0,
        cancellation_retained_fee: 0,
        refunded_amount: 0,
        pending_refund_amount: 0,
      });
    }
    const agg = payAggMap.get(accId);
    const amount = toNumber(row.payment_amount);
    const refunded = toNumber(row.refunded_amount);
    const collected = amount - refunded;
    const taxShare =
      row.payment_status !== "REFUNDED" && amount > 0
        ? roundVnd(toNumber(row.tax_amount) * (collected / amount))
        : 0;
    const netPreVat = collected - taxShare;

    agg.paid_transaction_count += 1;
    agg.gross_cash_collected += collected;
    agg.booking_tax_collected += taxShare;
    agg.refunded_amount += refunded;
    if (row.booking_status !== "CONFIRMED" && collected > 0) {
      agg.cancellation_retained_fee += collected;
    }

    if (!agg.bookingIds.has(row.booking_id)) {
      agg.bookingIds.add(row.booking_id);
      agg.rooms_subtotal += toNumber(row.rooms_subtotal);
      agg.extra_guest_total += toNumber(row.extra_guest_total);
      agg.service_fee += toNumber(row.service_fee);
      agg.discounts += toNumber(row.room_discount_total) + toNumber(row.discount_amount);
    }

    const paidDate = row.paid_at ? new Date(row.paid_at) : null;
    if (paidDate && !Number.isNaN(paidDate.getTime())) {
      const m = paidDate.getUTCMonth() + 1;
      monthlyPaymentSeries[m - 1].grossCashCollected += collected;
      monthlyPaymentSeries[m - 1].bookingTaxCollected += taxShare;
      monthlyPaymentSeries[m - 1].netBookingRevenuePreVat += netPreVat;

      if (!paidBookingsByAccMonth.has(accId)) paidBookingsByAccMonth.set(accId, new Map());
      const accMonthMap = paidBookingsByAccMonth.get(accId);
      accMonthMap.set(m, (accMonthMap.get(m) || 0) + 1);
    }
  }

  for (const pr of pendingRefRes.recordset) {
    const accId = Number(pr.accommodation_id);
    if (!payAggMap.has(accId)) {
      payAggMap.set(accId, {
        bookingIds: new Set(),
        paid_transaction_count: 0,
        gross_cash_collected: 0,
        booking_tax_collected: 0,
        rooms_subtotal: 0,
        extra_guest_total: 0,
        service_fee: 0,
        discounts: 0,
        cancellation_retained_fee: 0,
        refunded_amount: 0,
        pending_refund_amount: 0,
      });
    }
    payAggMap.get(accId).pending_refund_amount += toNumber(pr.pending_refund_amount);
  }

  // Compute sold room nights intersected with each month in period.months
  const soldNightsByAccMonth = new Map();
  for (const bk of nightsRes.recordset) {
    const accId = Number(bk.accommodation_id);
    if (!soldNightsByAccMonth.has(accId)) soldNightsByAccMonth.set(accId, new Map());
    const accMap = soldNightsByAccMonth.get(accId);
    const totalRooms = Math.max(1, toNumber(bk.total_rooms, 1));

    for (const m of period.months) {
      const mStart = new Date(Date.UTC(period.year, m - 1, 1));
      const mEnd = new Date(Date.UTC(period.year, m, 1));
      const ov = computeOverlapNights(bk.check_in_date, bk.check_out_date, mStart, mEnd);
      if (ov > 0) {
        accMap.set(m, (accMap.get(m) || 0) + ov * totalRooms);
      }
    }
  }

  const latestWarningMap = new Map();
  for (const w of warnRes.recordset) latestWarningMap.set(Number(w.accommodation_id), w);

  // Also compute booking net cash per month per accommodation for monthly chart breakdown
  const monthlyAccBookingNet = new Map();
  for (const row of payRes.recordset) {
    const accId = Number(row.accommodation_id);
    const paidDate = row.paid_at ? new Date(row.paid_at) : null;
    if (!paidDate || Number.isNaN(paidDate.getTime())) continue;
    const m = paidDate.getUTCMonth() + 1;
    const amount = toNumber(row.payment_amount);
    const refunded = toNumber(row.refunded_amount);
    const collected = amount - refunded;
    const taxShare =
      row.payment_status !== "REFUNDED" && amount > 0
        ? roundVnd(toNumber(row.tax_amount) * (collected / amount))
        : 0;
    const key = `${accId}:${m}`;
    monthlyAccBookingNet.set(key, (monthlyAccBookingNet.get(key) || 0) + (collected - taxShare));
  }

  const now = new Date();
  const computedRows = accRes.recordset.map((acc) => {
    const accId = Number(acc.id);
    const aggRaw = payAggMap.get(accId) || {};
    const bookingPaymentAgg = {
      ...aggRaw,
      booking_count: aggRaw.bookingIds ? aggRaw.bookingIds.size : 0,
    };

    const row = computePropertyPnl({
      property: acc,
      profile: profileMap.get(accId) || null,
      months: period.months,
      year: period.year,
      ledgersByMonth: ledgerMap.get(accId) || new Map(),
      bookingPaymentAgg,
      soldNightsByMonth: soldNightsByAccMonth.get(accId) || new Map(),
      paidBookingsByMonth: paidBookingsByAccMonth.get(accId) || new Map(),
      asOfDate: now,
    });

    row.latest_warning = latestWarningMap.get(accId) || null;
    row.monthly_breakdown = row.monthly_breakdown.map((mb) => {
      const bNet = monthlyAccBookingNet.get(`${accId}:${mb.month}`) || 0;
      const rev = bNet + mb.extra_facility_revenue;
      const ebtM = rev - mb.total_expenses;
      const taxM = ebtM > 0 ? roundVnd(ebtM * (row.tax_rate_percent / 100)) : 0;
      return {
        ...mb,
        booking_net_revenue: bNet,
        total_revenue: rev,
        ebt: ebtM,
        tax_amount: taxM,
        net_profit_after_tax: ebtM - taxM,
      };
    });

    return row;
  });

  // Only rank across full set for ADMIN; Manager sees own scoped properties without fake global #1 badge
  const rankedRows = isAdmin
    ? classifyAndRankProperties(computedRows, { rankingMode, sortBy })
    : classifyAndRankProperties(computedRows, { rankingMode: "CHAIN", sortBy }).map((r) => ({
        ...r,
        ranking_position: null,
        top_bonus_rate_percent: 0,
        top_bonus_amount: 0,
      }));

  return { period, rankingMode, sortBy, isAdmin, allRankedRows: rankedRows };
}

function applyOverviewDisplayFilters(rows, filters = {}) {
  const locationId =
    filters.locationId && filters.locationId !== "all" ? Number(filters.locationId) : null;
  const accommodationTypeId =
    filters.accommodationTypeId && filters.accommodationTypeId !== "all"
      ? Number(filters.accommodationTypeId)
      : null;
  const performanceTier =
    filters.performanceTier && filters.performanceTier !== "ALL"
      ? String(filters.performanceTier).toUpperCase()
      : null;
  const search = String(filters.search || "").trim().toLowerCase();

  return rows.filter((row) => {
    if (locationId && row.location_id !== locationId) return false;
    if (accommodationTypeId && row.accommodation_type_id !== accommodationTypeId) return false;

    if (performanceTier) {
      if (performanceTier === "WARNING") {
        if (!["NEGATIVE_LOSS", "LOW_OR_ZERO"].includes(row.performance_tier)) return false;
      } else if (performanceTier === "TOP_3") {
        if (!["TOP_1", "TOP_2", "TOP_3"].includes(row.performance_tier)) return false;
      } else if (row.performance_tier !== performanceTier) {
        return false;
      }
    }

    if (search) {
      const hay = [
        row.accommodation_name,
        row.accommodation_code,
        row.manager_name,
        row.manager_personal_email,
        row.location_name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }

    return true;
  });
}

async function getChainFinancialOverview(filters = {}, actor = {}) {
  const { period, rankingMode, sortBy, isAdmin, allRankedRows } =
    await loadAndComputeFinancialRows(filters, actor);
  const filteredRows = applyOverviewDisplayFilters(allRankedRows, filters);

  // KPI Aggregates on currently filtered dataset
  const summary = {
    propertyCount: filteredRows.length,
    totalNetBookingRevenuePreVat: 0,
    totalGrossCashCollected: 0,
    totalBookingTaxCollected: 0,
    totalExtraFacilityRevenue: 0,
    totalNetRevenue: 0,
    totalGrossCashPlusFacility: 0,
    totalOperatingExpenses: 0,
    totalEbt: 0,
    totalCorporateTaxAmount: 0,
    totalNetProfitAfterTax: 0,
    estimatedTopBonusPool: 0,
    totalRefundedAmount: 0,
    pendingRefundProcessingAmount: 0,
    negativeCount: 0,
    lowOrZeroCount: 0,
    profitableCount: 0,
    warningCount: 0,
    vacantManagerCount: 0,
    expenseBreakdown: {
      staff_payroll_cost: 0,
      manager_salary_cost: 0,
      asset_depreciation_cost: 0,
      electricity_cost: 0,
      water_cost: 0,
      maintenance_repair_cost: 0,
      other_operating_cost: 0,
      internet_fuel_cost: 0,
    },
  };

  const monthlyMap = new Map();
  for (const m of period.months) {
    monthlyMap.set(m, {
      month: m,
      label: `Thg ${m}`,
      bookingRevenuePreVat: 0,
      extraFacilityRevenue: 0,
      totalRevenue: 0,
      totalExpenses: 0,
      ebt: 0,
      netProfitAfterTax: 0,
    });
  }

  for (const r of filteredRows) {
    summary.totalNetBookingRevenuePreVat += r.net_booking_revenue_pre_vat;
    summary.totalGrossCashCollected += r.gross_cash_collected;
    summary.totalBookingTaxCollected += r.booking_tax_collected;
    summary.totalExtraFacilityRevenue += r.extra_facility_revenue;
    summary.totalNetRevenue += r.total_net_revenue;
    summary.totalGrossCashPlusFacility += r.gross_cash_plus_facility;
    summary.totalOperatingExpenses += r.total_expenses;
    summary.totalEbt += r.ebt;
    summary.totalCorporateTaxAmount += r.tax_amount;
    summary.totalNetProfitAfterTax += r.net_profit_after_tax;
    summary.estimatedTopBonusPool += r.top_bonus_amount;
    summary.totalRefundedAmount += r.refunded_amount;
    summary.pendingRefundProcessingAmount += r.pending_refund_amount;

    if (r.performance_tier === "NEGATIVE_LOSS") summary.negativeCount += 1;
    else if (r.performance_tier === "LOW_OR_ZERO") summary.lowOrZeroCount += 1;
    else summary.profitableCount += 1;

    if (["NEGATIVE_LOSS", "LOW_OR_ZERO"].includes(r.performance_tier)) summary.warningCount += 1;
    if (!r.manager_user_id) summary.vacantManagerCount += 1;

    summary.expenseBreakdown.staff_payroll_cost += r.expenses.staff_payroll_cost;
    summary.expenseBreakdown.manager_salary_cost += r.expenses.manager_salary_cost;
    summary.expenseBreakdown.asset_depreciation_cost += r.expenses.asset_depreciation_cost;
    summary.expenseBreakdown.electricity_cost += r.expenses.electricity_cost;
    summary.expenseBreakdown.water_cost += r.expenses.water_cost;
    summary.expenseBreakdown.maintenance_repair_cost += r.expenses.maintenance_repair_cost;
    summary.expenseBreakdown.other_operating_cost += r.expenses.other_operating_cost;
    summary.expenseBreakdown.internet_fuel_cost += r.expenses.internet_fuel_cost;

    for (const mb of r.monthly_breakdown) {
      const mBucket = monthlyMap.get(mb.month);
      if (!mBucket) continue;
      mBucket.bookingRevenuePreVat += mb.booking_net_revenue;
      mBucket.extraFacilityRevenue += mb.extra_facility_revenue;
      mBucket.totalRevenue += mb.total_revenue;
      mBucket.totalExpenses += mb.total_expenses;
      mBucket.ebt += mb.ebt;
      mBucket.netProfitAfterTax += mb.net_profit_after_tax;
    }
  }

  // Top podium & Warning spotlight (from allRankedRows so podium reflects true ranking even when filtering Tab 1 table)
  const topPerformers = isAdmin
    ? allRankedRows.filter((r) => ["TOP_1", "TOP_2", "TOP_3"].includes(r.performance_tier))
    : [];
  const warningProperties = filteredRows
    .filter((r) => ["NEGATIVE_LOSS", "LOW_OR_ZERO"].includes(r.performance_tier))
    .sort((a, b) => a.net_profit_after_tax - b.net_profit_after_tax);

  return {
    period: {
      year: period.year,
      periodType: period.periodType,
      quarter: period.quarter,
      month: period.month,
      months: period.months,
      periodStart: period.periodStartStr,
      periodEnd: period.periodEndStr,
      periodLabel: period.periodLabel,
    },
    rankingMode,
    sortBy,
    scope: isAdmin ? "ADMIN_CHAIN" : "MANAGER_SCOPED",
    summary,
    monthlySeries: [...monthlyMap.values()],
    topPerformers,
    warningProperties,
    properties: filteredRows,
  };
}

async function getAccommodationFinancialDetail(accommodationId, filters = {}, actor = {}) {
  await assertAccommodationAccess(accommodationId, actor);
  const pool = getDBPool();
  const id = Number(accommodationId);

  const { period, allRankedRows } = await loadAndComputeFinancialRows(filters, actor);
  const propertyPnl = allRankedRows.find((r) => r.accommodation_id === id);
  if (!propertyPnl) {
    throw new FinancialReportError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy dữ liệu tài chính cơ sở.");
  }

  // Room-type revenue breakdown + warning history + manager tenure net profit check
  const [rtRes, warnRes, tenureRes] = await Promise.all([
    pool
      .request()
      .input("accId", sql.Int, id)
      .input("periodStart", sql.DateTime2, period.periodStart)
      .input("periodEnd", sql.DateTime2, period.periodEnd)
      .query(`
        SELECT
          bi.room_type_id,
          bi.room_type_name,
          COUNT(bi.id) AS room_bookings_count,
          SUM(b.total_nights) AS booked_room_nights,
          SUM(bi.room_subtotal) AS room_subtotal,
          SUM(bi.extra_adult_total + bi.extra_child_total) AS extra_guest_total,
          SUM(bi.total_amount) AS item_total_amount
        FROM dbo.booking_items bi
        JOIN dbo.bookings b ON b.id = bi.booking_id
        WHERE b.accommodation_id = @accId
          AND b.status = 'CONFIRMED'
          AND EXISTS (
            SELECT 1
            FROM dbo.payments p
            WHERE p.booking_id = b.id
              AND p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED')
              AND p.paid_at >= @periodStart
              AND p.paid_at < @periodEnd
          )
        GROUP BY bi.room_type_id, bi.room_type_name
        ORDER BY SUM(bi.total_amount) DESC;
      `),
    pool
      .request()
      .input("accId", sql.Int, id)
      .query(`
        SELECT TOP 15
          w.*,
          uAdmin.full_name AS sent_by_admin_name
        FROM dbo.accommodation_financial_warnings w
        LEFT JOIN dbo.users uAdmin ON uAdmin.id = w.sent_by_admin_id
        WHERE w.accommodation_id = @accId
        ORDER BY w.created_at DESC, w.id DESC;
      `),
    propertyPnl.assigned_at
      ? pool
          .request()
          .input("accId", sql.Int, id)
          .input("assignedAt", sql.DateTime2, new Date(propertyPnl.assigned_at))
          .input("periodEnd", sql.DateTime2, period.periodEnd)
          .query(`
            SELECT
              SUM(CASE WHEN p.status IN ('SUCCESS','PARTIALLY_REFUNDED','REFUNDED') THEN p.amount - p.refunded_amount ELSE 0 END)
              - SUM(CASE WHEN p.status IN ('SUCCESS','PARTIALLY_REFUNDED') AND p.amount > 0
                         THEN ROUND(b.tax_amount * ((p.amount - p.refunded_amount) / p.amount), 0) ELSE 0 END) AS tenure_booking_net
            FROM dbo.bookings b
            JOIN dbo.payments p ON p.booking_id = b.id
            WHERE b.accommodation_id = @accId
              AND p.paid_at >= @assignedAt
              AND p.paid_at < @periodEnd;
          `)
      : Promise.resolve({ recordset: [{ tenure_booking_net: 0 }] }),
  ]);

  const fullYearLedgersRes = await pool
    .request()
    .input("accId", sql.Int, id)
    .input("year", sql.Int, period.year)
    .query(`
      SELECT *
      FROM dbo.accommodation_monthly_ledgers
      WHERE accommodation_id = @accId AND period_year = @year
      ORDER BY period_month ASC;
    `);

  let managerTenureProfit = null;
  if (propertyPnl.assigned_at) {
    const assignedDate = new Date(propertyPnl.assigned_at);
    const tenureMonths = propertyPnl.monthly_breakdown.filter((mb) => {
      const mStart = new Date(Date.UTC(period.year, mb.month - 1, 1));
      const assignedMonthStart = new Date(
        Date.UTC(assignedDate.getUTCFullYear(), assignedDate.getUTCMonth(), 1),
      );
      return mStart >= assignedMonthStart;
    });
    const tenureBookingNet = toNumber(tenureRes.recordset?.[0]?.tenure_booking_net);
    const tenureExtra = tenureMonths.reduce((s, m) => s + m.extra_facility_revenue, 0);
    const tenureOpex = tenureMonths.reduce((s, m) => s + m.total_expenses, 0);
    const tenureEbt = tenureBookingNet + tenureExtra - tenureOpex;
    const tenureTax = tenureEbt > 0 ? roundVnd(tenureEbt * (propertyPnl.tax_rate_percent / 100)) : 0;
    managerTenureProfit = tenureEbt - tenureTax;
  }

  return {
    period: {
      year: period.year,
      periodType: period.periodType,
      quarter: period.quarter,
      month: period.month,
      periodLabel: period.periodLabel,
    },
    property: {
      ...propertyPnl,
      manager_tenure_net_profit: managerTenureProfit,
    },
    roomTypeBreakdown: rtRes.recordset,
    ledgers: fullYearLedgersRes.recordset,
    warningsHistory: warnRes.recordset,
  };
}

function validateNonNegativeNumber(val, fieldLabel) {
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) {
    throw new FinancialReportError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      `${fieldLabel} phải là số hợp lệ >= 0.`,
    );
  }
  return num;
}

async function upsertAccommodationMonthlyLedger(accommodationId, payload = {}, adminUser = {}) {
  const id = Number(accommodationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Mã cơ sở không hợp lệ.");
  }

  const year = Number(payload.period_year ?? payload.year);
  const month = Number(payload.period_month ?? payload.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Năm sổ cái không hợp lệ.");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Tháng sổ cái phải từ 1 đến 12.");
  }

  const pool = getDBPool();
  const accExists = await pool
    .request()
    .input("id", sql.Int, id)
    .query(`SELECT id, accommodation_name FROM dbo.accommodations WHERE id = @id AND deleted_at IS NULL;`);
  if (!accExists.recordset.length) {
    throw new FinancialReportError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy cơ sở lưu trú.");
  }

  const fields = {
    ancillary_service_revenue: validateNonNegativeNumber(payload.ancillary_service_revenue ?? 0, "Thu dịch vụ phụ trợ"),
    other_rental_revenue: validateNonNegativeNumber(payload.other_rental_revenue ?? 0, "Thu cho thuê khác"),
    electricity_cost: validateNonNegativeNumber(payload.electricity_cost ?? 0, "Chi phí điện"),
    water_cost: validateNonNegativeNumber(payload.water_cost ?? 0, "Chi phí nước"),
    internet_fuel_cost: validateNonNegativeNumber(payload.internet_fuel_cost ?? 0, "Chi phí Internet & nhiên liệu"),
    asset_depreciation_cost: validateNonNegativeNumber(payload.asset_depreciation_cost ?? 0, "Khấu hao tài sản"),
    maintenance_repair_cost: validateNonNegativeNumber(payload.maintenance_repair_cost ?? 0, "Bảo trì & sửa chữa"),
    manager_salary_cost: validateNonNegativeNumber(payload.manager_salary_cost ?? 0, "Lương Manager"),
    staff_payroll_cost: validateNonNegativeNumber(payload.staff_payroll_cost ?? 0, "Quỹ lương nhân viên"),
    other_operating_cost: validateNonNegativeNumber(payload.other_operating_cost ?? 0, "Chi phí vận hành khác"),
    staff_headcount_snapshot: Math.trunc(validateNonNegativeNumber(payload.staff_headcount_snapshot ?? 8, "Số nhân sự")),
    is_locked: payload.is_locked ? 1 : 0,
    note: payload.note ? String(payload.note).slice(0, 1000) : null,
  };

  const req = pool
    .request()
    .input("accommodation_id", sql.Int, id)
    .input("period_year", sql.Int, year)
    .input("period_month", sql.TinyInt, month)
    .input("ancillary_service_revenue", sql.Decimal(18, 2), fields.ancillary_service_revenue)
    .input("other_rental_revenue", sql.Decimal(18, 2), fields.other_rental_revenue)
    .input("electricity_cost", sql.Decimal(18, 2), fields.electricity_cost)
    .input("water_cost", sql.Decimal(18, 2), fields.water_cost)
    .input("internet_fuel_cost", sql.Decimal(18, 2), fields.internet_fuel_cost)
    .input("asset_depreciation_cost", sql.Decimal(18, 2), fields.asset_depreciation_cost)
    .input("maintenance_repair_cost", sql.Decimal(18, 2), fields.maintenance_repair_cost)
    .input("manager_salary_cost", sql.Decimal(18, 2), fields.manager_salary_cost)
    .input("staff_payroll_cost", sql.Decimal(18, 2), fields.staff_payroll_cost)
    .input("other_operating_cost", sql.Decimal(18, 2), fields.other_operating_cost)
    .input("staff_headcount_snapshot", sql.Int, fields.staff_headcount_snapshot)
    .input("is_locked", sql.Bit, fields.is_locked)
    .input("note", sql.NVarChar(1000), fields.note)
    .input("updated_by_user_id", sql.UniqueIdentifier, adminUser.id || null);

  const upsertRes = await req.query(`
    MERGE dbo.accommodation_monthly_ledgers AS target
    USING (SELECT @accommodation_id AS accommodation_id, @period_year AS period_year, @period_month AS period_month) AS src
      ON target.accommodation_id = src.accommodation_id
     AND target.period_year = src.period_year
     AND target.period_month = src.period_month
    WHEN MATCHED THEN
      UPDATE SET
        ancillary_service_revenue = @ancillary_service_revenue,
        other_rental_revenue = @other_rental_revenue,
        electricity_cost = @electricity_cost,
        water_cost = @water_cost,
        internet_fuel_cost = @internet_fuel_cost,
        asset_depreciation_cost = @asset_depreciation_cost,
        maintenance_repair_cost = @maintenance_repair_cost,
        manager_salary_cost = @manager_salary_cost,
        staff_payroll_cost = @staff_payroll_cost,
        other_operating_cost = @other_operating_cost,
        staff_headcount_snapshot = @staff_headcount_snapshot,
        is_locked = @is_locked,
        note = @note,
        updated_by_user_id = @updated_by_user_id,
        updated_at = SYSDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (
        accommodation_id, period_year, period_month,
        ancillary_service_revenue, other_rental_revenue,
        electricity_cost, water_cost, internet_fuel_cost,
        asset_depreciation_cost, maintenance_repair_cost,
        manager_salary_cost, staff_payroll_cost, other_operating_cost,
        staff_headcount_snapshot, is_locked, note, updated_by_user_id
      )
      VALUES (
        @accommodation_id, @period_year, @period_month,
        @ancillary_service_revenue, @other_rental_revenue,
        @electricity_cost, @water_cost, @internet_fuel_cost,
        @asset_depreciation_cost, @maintenance_repair_cost,
        @manager_salary_cost, @staff_payroll_cost, @other_operating_cost,
        @staff_headcount_snapshot, @is_locked, @note, @updated_by_user_id
      )
    OUTPUT INSERTED.*;
  `);

  return upsertRes.recordset[0];
}

async function updateAccommodationOperatingProfile(accommodationId, payload = {}, adminUser = {}) {
  const id = Number(accommodationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Mã cơ sở không hợp lệ.");
  }

  const pool = getDBPool();
  const accExists = await pool
    .request()
    .input("id", sql.Int, id)
    .query(`SELECT id FROM dbo.accommodations WHERE id = @id AND deleted_at IS NULL;`);
  if (!accExists.recordset.length) {
    throw new FinancialReportError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy cơ sở lưu trú.");
  }

  const staffHeadcount = Math.trunc(validateNonNegativeNumber(payload.staff_headcount ?? 8, "Số lượng nhân viên"));
  const staffAvgSalary = validateNonNegativeNumber(payload.staff_avg_salary ?? 7500000, "Lương bình quân nhân viên");
  const staffMonthlyPayroll =
    payload.staff_monthly_payroll !== undefined && payload.staff_monthly_payroll !== null
      ? validateNonNegativeNumber(payload.staff_monthly_payroll, "Tổng quỹ lương nhân viên")
      : staffHeadcount * staffAvgSalary;

  const taxRate = validateNonNegativeNumber(payload.tax_rate_percent ?? 10, "Thuế suất TNDN");
  if (taxRate > 100) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Thuế suất TNDN phải từ 0% đến 100%.");
  }

  const opexStartDate = payload.opex_start_date ? new Date(payload.opex_start_date) : new Date("2026-01-01");
  if (Number.isNaN(opexStartDate.getTime())) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Ngày bắt đầu hạch toán OPEX không hợp lệ.");
  }

  const req = pool
    .request()
    .input("accommodation_id", sql.Int, id)
    .input("staff_headcount", sql.Int, staffHeadcount)
    .input("manager_base_salary", sql.Decimal(18, 2), validateNonNegativeNumber(payload.manager_base_salary ?? 15000000, "Lương cơ bản Manager"))
    .input("staff_avg_salary", sql.Decimal(18, 2), staffAvgSalary)
    .input("staff_monthly_payroll", sql.Decimal(18, 2), staffMonthlyPayroll)
    .input("base_electricity_cost", sql.Decimal(18, 2), validateNonNegativeNumber(payload.base_electricity_cost ?? 12000000, "Tiền điện cố định"))
    .input("base_water_cost", sql.Decimal(18, 2), validateNonNegativeNumber(payload.base_water_cost ?? 3500000, "Tiền nước cố định"))
    .input("variable_utility_per_room_night", sql.Decimal(18, 2), validateNonNegativeNumber(payload.variable_utility_per_room_night ?? 85000, "Biến phí điện nước/đêm phòng"))
    .input("internet_fuel_cost", sql.Decimal(18, 2), validateNonNegativeNumber(payload.internet_fuel_cost ?? 2500000, "Chi phí Internet & nhiên liệu"))
    .input("monthly_asset_depreciation", sql.Decimal(18, 2), validateNonNegativeNumber(payload.monthly_asset_depreciation ?? 18000000, "Khấu hao tài sản cố định"))
    .input("monthly_maintenance_supplies", sql.Decimal(18, 2), validateNonNegativeNumber(payload.monthly_maintenance_supplies ?? 6500000, "Bảo trì & vật tư"))
    .input("other_fixed_opex", sql.Decimal(18, 2), validateNonNegativeNumber(payload.other_fixed_opex ?? 4000000, "Chi phí cố định khác"))
    .input("tax_rate_percent", sql.Decimal(5, 2), taxRate)
    .input("monthly_target_net_profit", sql.Decimal(18, 2), validateNonNegativeNumber(payload.monthly_target_net_profit ?? 50000000, "Chỉ tiêu lợi nhuận tháng"))
    .input("opex_start_date", sql.Date, formatDateYmd(opexStartDate))
    .input("updated_by_user_id", sql.UniqueIdentifier, adminUser.id || null);

  const res = await req.query(`
    MERGE dbo.accommodation_operating_profiles AS target
    USING (SELECT @accommodation_id AS accommodation_id) AS src
      ON target.accommodation_id = src.accommodation_id
    WHEN MATCHED THEN
      UPDATE SET
        staff_headcount = @staff_headcount,
        manager_base_salary = @manager_base_salary,
        staff_avg_salary = @staff_avg_salary,
        staff_monthly_payroll = @staff_monthly_payroll,
        base_electricity_cost = @base_electricity_cost,
        base_water_cost = @base_water_cost,
        variable_utility_per_room_night = @variable_utility_per_room_night,
        internet_fuel_cost = @internet_fuel_cost,
        monthly_asset_depreciation = @monthly_asset_depreciation,
        monthly_maintenance_supplies = @monthly_maintenance_supplies,
        other_fixed_opex = @other_fixed_opex,
        tax_rate_percent = @tax_rate_percent,
        monthly_target_net_profit = @monthly_target_net_profit,
        opex_start_date = @opex_start_date,
        updated_by_user_id = @updated_by_user_id,
        updated_at = SYSDATETIME()
    WHEN NOT MATCHED THEN
      INSERT (
        accommodation_id, staff_headcount, manager_base_salary, staff_avg_salary,
        staff_monthly_payroll, base_electricity_cost, base_water_cost,
        variable_utility_per_room_night, internet_fuel_cost, monthly_asset_depreciation,
        monthly_maintenance_supplies, other_fixed_opex, tax_rate_percent,
        monthly_target_net_profit, opex_start_date, updated_by_user_id
      )
      VALUES (
        @accommodation_id, @staff_headcount, @manager_base_salary, @staff_avg_salary,
        @staff_monthly_payroll, @base_electricity_cost, @base_water_cost,
        @variable_utility_per_room_night, @internet_fuel_cost, @monthly_asset_depreciation,
        @monthly_maintenance_supplies, @other_fixed_opex, @tax_rate_percent,
        @monthly_target_net_profit, @opex_start_date, @updated_by_user_id
      )
    OUTPUT INSERTED.*;
  `);

  return res.recordset[0];
}

/**
 * Safely read Phase 2 Chatbox CSKH penalties without crashing when the table does not yet exist.
 */
async function loadChatboxViolationsIfExists(pool, periodStart, periodEnd) {
  try {
    const check = await pool.request().query(`
      SELECT OBJECT_ID('dbo.chat_conversation_ratings', 'U') AS obj_id;
    `);
    const exists = Boolean(check.recordset?.[0]?.obj_id);
    if (!exists) {
      return { phase2Active: false, violatedManagerIds: new Set() };
    }

    const res = await pool
      .request()
      .input("periodStart", sql.DateTime2, periodStart)
      .input("periodEnd", sql.DateTime2, periodEnd)
      .query(`
        SELECT DISTINCT manager_user_id
        FROM dbo.chat_conversation_ratings
        WHERE manager_user_id IS NOT NULL
          AND review_status = 'CONFIRMED_VIOLATION'
          AND created_at >= @periodStart
          AND created_at < @periodEnd;
      `);

    return {
      phase2Active: true,
      violatedManagerIds: new Set(res.recordset.map((r) => String(r.manager_user_id).toLowerCase())),
    };
  } catch (err) {
    console.warn("[financial_report_service] Chatbox Future Hook check skipped:", err.message);
    return { phase2Active: false, violatedManagerIds: new Set() };
  }
}

function normalizeSettlementParams(params = {}) {
  const settlementType = String(params.settlementType || params.settlement_type || "ANNUAL_TET_13TH")
    .trim()
    .toUpperCase();
  if (!["ANNUAL_TET_13TH", "MONTHLY_TOP_BONUS", "QUARTERLY_TOP_BONUS"].includes(settlementType)) {
    throw new FinancialReportError(
      400,
      ERROR_CODES.VALIDATION_ERROR,
      "settlementType chỉ hỗ trợ ANNUAL_TET_13TH, MONTHLY_TOP_BONUS hoặc QUARTERLY_TOP_BONUS.",
    );
  }

  const periodYear = Number(params.year ?? params.period_year ?? getCurrentCalendarYear());
  if (!Number.isInteger(periodYear) || periodYear < 2000 || periodYear > 2100) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Năm quyết toán không hợp lệ.");
  }
  let periodQuarter = 0;
  let periodMonth = 0;
  let overviewFilters = { year: periodYear, rankingMode: params.rankingMode };

  if (settlementType === "MONTHLY_TOP_BONUS") {
    periodMonth = Number(params.month ?? params.period_month ?? new Date().getMonth() + 1);
    if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
      throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Tháng quyết toán phải từ 1 đến 12.");
    }
    overviewFilters = { ...overviewFilters, periodType: "MONTH", month: periodMonth };
  } else if (settlementType === "QUARTERLY_TOP_BONUS") {
    periodQuarter = Number(params.quarter ?? params.period_quarter ?? 1);
    if (!Number.isInteger(periodQuarter) || periodQuarter < 1 || periodQuarter > 4) {
      throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Quý quyết toán phải từ 1 đến 4.");
    }
    overviewFilters = { ...overviewFilters, periodType: "QUARTER", quarter: periodQuarter };
  } else {
    overviewFilters = { ...overviewFilters, periodType: "YEAR" };
  }

  return { settlementType, periodYear, periodQuarter, periodMonth, overviewFilters };
}

async function getTetBonusAnd13thSalaryPreview(params = {}, actor = {}) {
  const pool = getDBPool();
  const { settlementType, periodYear, periodQuarter, periodMonth, overviewFilters } =
    normalizeSettlementParams(params);
  const workingMonthsOverrides = params.workingMonthsOverrides || {};

  const { period, allRankedRows } = await loadAndComputeFinancialRows(overviewFilters, actor);

  const [existingRes, priorDeductRes, chatboxCheck] = await Promise.all([
    pool
      .request()
      .input("settlementType", sql.VarChar(24), settlementType)
      .input("periodYear", sql.Int, periodYear)
      .input("periodQuarter", sql.TinyInt, periodQuarter)
      .input("periodMonth", sql.TinyInt, periodMonth)
      .query(`
        SELECT *
        FROM dbo.accommodation_bonus_settlements
        WHERE settlement_type = @settlementType
          AND period_year = @periodYear
          AND period_quarter = @periodQuarter
          AND period_month = @periodMonth;
      `),
    settlementType === "ANNUAL_TET_13TH"
      ? pool
          .request()
          .input("periodYear", sql.Int, periodYear)
          .query(`
            SELECT
              accommodation_id,
              SUM(ROUND(top_bonus_amount * property_kpi_multiplier, 0)) AS deducted_amount
            FROM dbo.accommodation_bonus_settlements
            WHERE period_year = @periodYear
              AND settlement_type IN ('MONTHLY_TOP_BONUS', 'QUARTERLY_TOP_BONUS')
              AND status IN ('APPROVED', 'PAID')
            GROUP BY accommodation_id;
          `)
      : Promise.resolve({ recordset: [] }),
    loadChatboxViolationsIfExists(pool, period.periodStart, period.periodEnd),
  ]);

  const existingMap = new Map();
  for (const row of existingRes.recordset) existingMap.set(Number(row.accommodation_id), row);

  const priorMap = new Map();
  for (const row of priorDeductRes.recordset) {
    priorMap.set(Number(row.accommodation_id), toNumber(row.deducted_amount));
  }

  const now = new Date();
  const rows = allRankedRows.map((rp) => {
    const accId = rp.accommodation_id;
    const mgrIdKey = rp.manager_user_id ? String(rp.manager_user_id).toLowerCase() : null;
    const csPenaltyFactor =
      mgrIdKey && chatboxCheck.violatedManagerIds.has(mgrIdKey) ? 0.7 : 1.0;

    return calculateBonusSettlementRow({
      rankedProperty: rp,
      settlementType,
      periodYear,
      priorApprovedTopBonusDeducted: priorMap.get(accId) || 0,
      managerWorkingMonthsOverride: workingMonthsOverrides[accId] ?? workingMonthsOverrides[String(accId)],
      managerCsPenaltyFactor: csPenaltyFactor,
      existingSettlement: existingMap.get(accId) || null,
      asOfDate: now,
    });
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.totalManager13thSalary += r.manager_13th_salary;
      acc.totalManagerTetBonus += r.manager_tet_bonus;
      acc.totalStaffHeadcount += r.staff_headcount;
      acc.totalStaff13thSalaryPool += r.staff_13th_salary_pool;
      acc.totalStaffTetBonusPool += r.staff_tet_bonus_pool;
      acc.totalPriorDeducted += r.prior_period_top_bonus_deducted;
      acc.grandTotalPayout += r.total_payout_amount;
      if (r.settlement_status === "APPROVED" || r.settlement_status === "PAID") {
        acc.approvedCount += 1;
      }
      return acc;
    },
    {
      propertyCount: rows.length,
      approvedCount: 0,
      totalManager13thSalary: 0,
      totalManagerTetBonus: 0,
      totalStaffHeadcount: 0,
      totalStaff13thSalaryPool: 0,
      totalStaffTetBonusPool: 0,
      totalPriorDeducted: 0,
      grandTotalPayout: 0,
    },
  );

  return {
    settlementType,
    periodYear,
    periodQuarter,
    periodMonth,
    periodLabel: period.periodLabel,
    rankingMode: overviewFilters.rankingMode || "CHAIN",
    chatboxPhase2Active: chatboxCheck.phase2Active,
    totals,
    items: rows,
  };
}

async function approveAndSaveBonusSettlements(payload = {}, adminUser = {}) {
  const pool = getDBPool();
  const status = String(payload.status || "APPROVED").trim().toUpperCase();
  if (!["DRAFT", "APPROVED", "PAID"].includes(status)) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Trạng thái duyệt chỉ nhận DRAFT, APPROVED hoặc PAID.");
  }

  const sendEmails = Boolean(payload.sendEmails);
  const adminNote = payload.adminNote ? String(payload.adminNote).slice(0, 1000) : null;
  const targetIds = Array.isArray(payload.accommodationIds) && payload.accommodationIds.length
    ? new Set(payload.accommodationIds.map(Number))
    : null;

  const workingMonthsOverrides = {};
  if (Array.isArray(payload.overrides)) {
    for (const o of payload.overrides) {
      if (o?.accommodation_id) workingMonthsOverrides[Number(o.accommodation_id)] = o.manager_working_months;
    }
  } else if (payload.workingMonthsOverrides && typeof payload.workingMonthsOverrides === "object") {
    Object.assign(workingMonthsOverrides, payload.workingMonthsOverrides);
  }

  const preview = await getTetBonusAnd13thSalaryPreview(
    { ...payload, workingMonthsOverrides },
    adminUser,
  );

  const itemsToSave = targetIds
    ? preview.items.filter((it) => targetIds.has(it.accommodation_id))
    : preview.items;

  if (!itemsToSave.length) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Không có cơ sở nào khớp để phê duyệt.");
  }

  let savedCount = 0;
  let emailedCount = 0;
  let emailFailedCount = 0;
  let skippedNoManagerCount = 0;

  for (const row of itemsToSave) {
    let emailStatus = row.email_notification_status || (row.manager_user_id ? "NOT_SENT" : "SKIPPED_NO_MANAGER");
    let emailSentAt = row.email_sent_at ? new Date(row.email_sent_at) : null;

    if (!row.manager_user_id) {
      emailStatus = "SKIPPED_NO_MANAGER";
      skippedNoManagerCount += 1;
    } else if (sendEmails && (status === "APPROVED" || status === "PAID")) {
      const targetEmail = row.manager_personal_email || null;
      if (!targetEmail) {
        emailStatus = "SKIPPED_NO_MANAGER";
        skippedNoManagerCount += 1;
      } else {
        const mailRes = await mailService.sendManagerBonusAndTetRewardEmail({
          toGmail: targetEmail,
          managerName: row.manager_name,
          accommodationName: row.accommodation_name,
          periodLabel: preview.periodLabel,
          performanceTier: row.performance_tier,
          rankingPosition: row.ranking_position,
          topBonusRatePercent: row.top_bonus_rate_percent,
          manager13thSalary: row.manager_13th_salary,
          managerTetBonus: row.manager_tet_bonus,
          staff13thSalaryPool: row.staff_13th_salary_pool,
          staffTetBonusPool: row.staff_tet_bonus_pool,
          staffHeadcount: row.staff_headcount,
          totalPayoutAmount: row.total_payout_amount,
          adminNote,
        });
        if (mailRes.success) {
          emailStatus = "SENT";
          emailSentAt = new Date();
          emailedCount += 1;
        } else {
          emailStatus = "FAILED";
          emailFailedCount += 1;
        }
      }
    }

    const req = pool
      .request()
      .input("settlement_type", sql.VarChar(24), preview.settlementType)
      .input("period_year", sql.Int, preview.periodYear)
      .input("period_quarter", sql.TinyInt, preview.periodQuarter)
      .input("period_month", sql.TinyInt, preview.periodMonth)
      .input("accommodation_id", sql.Int, row.accommodation_id)
      .input("manager_user_id", sql.UniqueIdentifier, row.manager_user_id || null)
      .input("total_revenue", sql.Decimal(18, 2), row.total_revenue)
      .input("total_expenses", sql.Decimal(18, 2), row.total_expenses)
      .input("tax_amount", sql.Decimal(18, 2), row.tax_amount)
      .input("net_profit_after_tax", sql.Decimal(18, 2), row.net_profit_after_tax)
      .input("ranking_position", sql.Int, row.ranking_position)
      .input("performance_tier", sql.VarChar(32), row.performance_tier)
      .input("top_bonus_rate_percent", sql.Decimal(5, 2), row.top_bonus_rate_percent)
      .input("top_bonus_amount", sql.Decimal(18, 2), row.top_bonus_amount)
      .input("prior_period_top_bonus_deducted", sql.Decimal(18, 2), row.prior_period_top_bonus_deducted)
      .input("property_kpi_multiplier", sql.Decimal(4, 2), row.property_kpi_multiplier)
      .input("manager_cs_penalty_factor", sql.Decimal(4, 2), row.manager_cs_penalty_factor)
      .input("manager_working_months", sql.TinyInt, row.manager_working_months)
      .input("manager_13th_salary", sql.Decimal(18, 2), row.manager_13th_salary)
      .input("manager_tet_bonus", sql.Decimal(18, 2), row.manager_tet_bonus)
      .input("staff_headcount", sql.Int, row.staff_headcount)
      .input("staff_13th_salary_pool", sql.Decimal(18, 2), row.staff_13th_salary_pool)
      .input("staff_tet_bonus_pool", sql.Decimal(18, 2), row.staff_tet_bonus_pool)
      .input("total_payout_amount", sql.Decimal(18, 2), row.total_payout_amount)
      .input("status", sql.VarChar(24), status)
      .input("email_notification_status", sql.VarChar(24), emailStatus)
      .input("email_sent_at", sql.DateTime2, emailSentAt)
      .input("admin_note", sql.NVarChar(1000), adminNote)
      .input("approved_by_admin_id", sql.UniqueIdentifier, status === "APPROVED" || status === "PAID" ? adminUser.id || null : null)
      .input("approved_at", sql.DateTime2, status === "APPROVED" || status === "PAID" ? new Date() : null);

    await req.query(`
      MERGE dbo.accommodation_bonus_settlements AS target
      USING (
        SELECT @settlement_type AS settlement_type,
               @period_year AS period_year,
               @period_quarter AS period_quarter,
               @period_month AS period_month,
               @accommodation_id AS accommodation_id
      ) AS src
      ON target.settlement_type = src.settlement_type
     AND target.period_year = src.period_year
     AND target.period_quarter = src.period_quarter
     AND target.period_month = src.period_month
     AND target.accommodation_id = src.accommodation_id
      WHEN MATCHED THEN
        UPDATE SET
          manager_user_id = @manager_user_id,
          total_revenue = @total_revenue,
          total_expenses = @total_expenses,
          tax_amount = @tax_amount,
          net_profit_after_tax = @net_profit_after_tax,
          ranking_position = @ranking_position,
          performance_tier = @performance_tier,
          top_bonus_rate_percent = @top_bonus_rate_percent,
          top_bonus_amount = @top_bonus_amount,
          prior_period_top_bonus_deducted = @prior_period_top_bonus_deducted,
          property_kpi_multiplier = @property_kpi_multiplier,
          manager_cs_penalty_factor = @manager_cs_penalty_factor,
          manager_working_months = @manager_working_months,
          manager_13th_salary = @manager_13th_salary,
          manager_tet_bonus = @manager_tet_bonus,
          staff_headcount = @staff_headcount,
          staff_13th_salary_pool = @staff_13th_salary_pool,
          staff_tet_bonus_pool = @staff_tet_bonus_pool,
          total_payout_amount = @total_payout_amount,
          status = @status,
          email_notification_status = @email_notification_status,
          email_sent_at = @email_sent_at,
          admin_note = @admin_note,
          approved_by_admin_id = @approved_by_admin_id,
          approved_at = @approved_at,
          updated_at = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (
          settlement_type, period_year, period_quarter, period_month, accommodation_id,
          manager_user_id, total_revenue, total_expenses, tax_amount, net_profit_after_tax,
          ranking_position, performance_tier, top_bonus_rate_percent, top_bonus_amount,
          prior_period_top_bonus_deducted, property_kpi_multiplier, manager_cs_penalty_factor,
          manager_working_months, manager_13th_salary, manager_tet_bonus, staff_headcount,
          staff_13th_salary_pool, staff_tet_bonus_pool, total_payout_amount, status,
          email_notification_status, email_sent_at, admin_note, approved_by_admin_id, approved_at
        )
        VALUES (
          @settlement_type, @period_year, @period_quarter, @period_month, @accommodation_id,
          @manager_user_id, @total_revenue, @total_expenses, @tax_amount, @net_profit_after_tax,
          @ranking_position, @performance_tier, @top_bonus_rate_percent, @top_bonus_amount,
          @prior_period_top_bonus_deducted, @property_kpi_multiplier, @manager_cs_penalty_factor,
          @manager_working_months, @manager_13th_salary, @manager_tet_bonus, @staff_headcount,
          @staff_13th_salary_pool, @staff_tet_bonus_pool, @total_payout_amount, @status,
          @email_notification_status, @email_sent_at, @admin_note, @approved_by_admin_id, @approved_at
        );
    `);

    savedCount += 1;
  }

  return {
    settlementType: preview.settlementType,
    periodYear: preview.periodYear,
    periodLabel: preview.periodLabel,
    status,
    savedCount,
    emailedCount,
    emailFailedCount,
    skippedNoManagerCount,
  };
}

async function sendFinancialWarningEmailToManager(accommodationId, payload = {}, adminUser = {}) {
  const id = Number(accommodationId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Mã cơ sở không hợp lệ.");
  }

  const adminNote = String(payload.adminNote || payload.note || "").trim();
  if (!adminNote) {
    throw new FinancialReportError(400, ERROR_CODES.VALIDATION_ERROR, "Vui lòng nhập nội dung cảnh báo / yêu cầu giải trình gửi Manager.");
  }

  const { period, allRankedRows } = await loadAndComputeFinancialRows(payload, adminUser);
  const target = allRankedRows.find((r) => r.accommodation_id === id);
  if (!target) {
    throw new FinancialReportError(404, ERROR_CODES.NOT_FOUND, "Không tìm thấy cơ sở lưu trú.");
  }

  if (!target.manager_user_id || !target.manager_personal_email) {
    throw new FinancialReportError(
      409,
      ERROR_CODES.MANAGER_NOT_ASSIGNED,
      `Cơ sở "${target.accommodation_name}" hiện chưa có Manager có Gmail cá nhân để gửi cảnh báo.`,
    );
  }

  let warningType = String(payload.warningType || "").toUpperCase();
  if (!["NEGATIVE_PROFIT", "ZERO_REVENUE", "LOW_PERFORMANCE"].includes(warningType)) {
    if (target.net_profit_after_tax < 0) warningType = "NEGATIVE_PROFIT";
    else if (target.total_net_revenue === 0) warningType = "ZERO_REVENUE";
    else warningType = "LOW_PERFORMANCE";
  }

  const mailRes = await mailService.sendManagerFinancialWarningEmail({
    toGmail: target.manager_personal_email,
    managerName: target.manager_name,
    accommodationName: target.accommodation_name,
    periodLabel: period.periodLabel,
    totalRevenue: target.total_net_revenue,
    totalExpenses: target.total_expenses,
    netProfitAfterTax: target.net_profit_after_tax,
    warningType,
    adminNote,
  });

  const pool = getDBPool();
  const insertRes = await pool
    .request()
    .input("accommodation_id", sql.Int, id)
    .input("manager_user_id", sql.UniqueIdentifier, target.manager_user_id)
    .input("recipient_email", sql.VarChar(255), target.manager_personal_email)
    .input("period_label", sql.NVarChar(100), period.periodLabel)
    .input("total_revenue_snapshot", sql.Decimal(18, 2), target.total_net_revenue)
    .input("total_expenses_snapshot", sql.Decimal(18, 2), target.total_expenses)
    .input("net_profit_snapshot", sql.Decimal(18, 2), target.net_profit_after_tax)
    .input("warning_type", sql.VarChar(32), warningType)
    .input("admin_note", sql.NVarChar(2000), adminNote.slice(0, 2000))
    .input("email_status", sql.VarChar(24), mailRes.success ? "SENT" : "FAILED")
    .input("email_error", sql.NVarChar(1000), mailRes.error ? String(mailRes.error).slice(0, 1000) : null)
    .input("sent_by_admin_id", sql.UniqueIdentifier, adminUser.id || null)
    .query(`
      INSERT INTO dbo.accommodation_financial_warnings (
        accommodation_id, manager_user_id, recipient_email, period_label,
        total_revenue_snapshot, total_expenses_snapshot, net_profit_snapshot,
        warning_type, admin_note, email_status, email_error, sent_by_admin_id
      )
      OUTPUT INSERTED.*
      VALUES (
        @accommodation_id, @manager_user_id, @recipient_email, @period_label,
        @total_revenue_snapshot, @total_expenses_snapshot, @net_profit_snapshot,
        @warning_type, @admin_note, @email_status, @email_error, @sent_by_admin_id
      );
    `);

  return {
    warningLog: insertRes.recordset[0],
    deliveryMethod: mailRes.method,
    deliverySuccess: mailRes.success,
  };
}

async function getPaymentReconciliationLedger(filters = {}, actor = {}) {
  const pool = getDBPool();
  const period = normalizePeriodFilters(filters);
  const scope = getAccommodationScope(actor, "a");

  const statusFilter = filters.status && filters.status !== "ALL"
    ? String(filters.status).trim().toUpperCase()
    : null;
  const accommodationId =
    filters.accommodationId && filters.accommodationId !== "ALL"
      ? Number(filters.accommodationId)
      : null;
  const search = String(filters.search || "").trim();

  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20));
  const offset = (page - 1) * pageSize;

  const buildReq = (withPagination = false) => {
    const req = pool
      .request()
      .input("periodStart", sql.DateTime2, period.periodStart)
      .input("periodEnd", sql.DateTime2, period.periodEnd)
      .input("statusFilter", sql.VarChar(24), statusFilter)
      .input("accommodationId", sql.Int, accommodationId)
      .input("searchLike", sql.NVarChar(200), search ? `%${search}%` : null);
    if (withPagination) {
      req.input("offset", sql.Int, offset).input("pageSize", sql.Int, pageSize);
    }
    for (const inp of scope.inputs) req.input(inp.name, inp.type, inp.value);
    return req;
  };

  const whereClause = `
    WHERE a.deleted_at IS NULL
      AND ${scope.condition}
      AND ISNULL(p.paid_at, p.created_at) >= @periodStart
      AND ISNULL(p.paid_at, p.created_at) < @periodEnd
      AND (@statusFilter IS NULL OR p.status = @statusFilter)
      AND (@accommodationId IS NULL OR a.id = @accommodationId)
      AND (
        @searchLike IS NULL
        OR b.booking_code LIKE @searchLike
        OR p.payment_code LIKE @searchLike
        OR ISNULL(p.provider_transaction_id, '') LIKE @searchLike
        OR a.accommodation_name LIKE @searchLike
        OR b.contact_name LIKE @searchLike
      )
  `;

  const [rowsRes, summaryRes] = await Promise.all([
    buildReq(true).query(`
      SELECT
        p.id AS payment_id,
        p.payment_code,
        p.payment_method,
        p.provider_order_id,
        p.provider_transaction_id,
        p.amount,
        p.refunded_amount,
        (p.amount - p.refunded_amount) AS net_cash_collected,
        CASE
          WHEN p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED') AND p.amount > 0
          THEN ROUND(b.tax_amount * ((p.amount - p.refunded_amount) / p.amount), 0)
          ELSE 0
        END AS booking_tax_collected,
        p.status AS payment_status,
        p.refund_reason,
        p.paid_at,
        p.refunded_at,
        p.created_at,
        b.id AS booking_id,
        b.booking_code,
        b.status AS booking_status,
        b.contact_name,
        b.contact_phone,
        b.check_in_date,
        b.check_out_date,
        b.tax_amount AS booking_total_tax,
        a.id AS accommodation_id,
        a.accommodation_name,
        at.name AS accommodation_type_name
      FROM dbo.payments p
      JOIN dbo.bookings b ON b.id = p.booking_id
      JOIN dbo.accommodations a ON a.id = b.accommodation_id
      JOIN dbo.accommodation_types at ON at.id = a.accommodation_type_id
      ${whereClause}
      ORDER BY ISNULL(p.paid_at, p.created_at) DESC, p.id DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
    `),
    buildReq(false).query(`
      SELECT
        COUNT(*) AS total_transactions,
        ISNULL(SUM(CASE WHEN p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED') AND p.paid_at >= @periodStart AND p.paid_at < @periodEnd THEN p.amount ELSE 0 END), 0) AS total_gross_billed,
        ISNULL(SUM(CASE WHEN p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED') AND p.paid_at >= @periodStart AND p.paid_at < @periodEnd THEN p.refunded_amount ELSE 0 END), 0) AS total_refunded_amount,
        ISNULL(SUM(CASE WHEN p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED', 'REFUNDED') AND p.paid_at >= @periodStart AND p.paid_at < @periodEnd THEN (p.amount - p.refunded_amount) ELSE 0 END), 0) AS total_net_collected_cash,
        ISNULL(SUM(CASE WHEN p.status IN ('SUCCESS', 'PARTIALLY_REFUNDED') AND p.paid_at >= @periodStart AND p.paid_at < @periodEnd AND p.amount > 0 THEN ROUND(b.tax_amount * ((p.amount - p.refunded_amount) / p.amount), 0) ELSE 0 END), 0) AS total_vat_collected,
        ISNULL(SUM(CASE WHEN p.status = 'REFUND_PROCESSING' THEN p.amount ELSE 0 END), 0) AS pending_refund_amount,
        SUM(CASE WHEN p.status = 'REFUND_PROCESSING' THEN 1 ELSE 0 END) AS pending_refund_count
      FROM dbo.payments p
      JOIN dbo.bookings b ON b.id = p.booking_id
      JOIN dbo.accommodations a ON a.id = b.accommodation_id
      ${whereClause};
    `),
  ]);

  const s = summaryRes.recordset[0] || {};
  const totalTransactions = toNumber(s.total_transactions);
  const totalNetCollectedCash = toNumber(s.total_net_collected_cash);
  const totalVatCollected = toNumber(s.total_vat_collected);

  return {
    period: {
      year: period.year,
      periodType: period.periodType,
      quarter: period.quarter,
      month: period.month,
      periodLabel: period.periodLabel,
    },
    summary: {
      totalTransactions,
      totalGrossBilled: toNumber(s.total_gross_billed),
      totalRefundedAmount: toNumber(s.total_refunded_amount),
      totalNetCollectedCash,
      totalVatCollected,
      totalPreVatBookingRevenue: totalNetCollectedCash - totalVatCollected,
      pendingRefundAmount: toNumber(s.pending_refund_amount),
      pendingRefundCount: toNumber(s.pending_refund_count),
    },
    items: rowsRes.recordset.map((r) => {
      const netCash = toNumber(r.net_cash_collected);
      const vat = toNumber(r.booking_tax_collected);
      return {
        ...r,
        amount: toNumber(r.amount),
        refunded_amount: toNumber(r.refunded_amount),
        net_cash_collected: netCash,
        booking_tax_collected: vat,
        pre_vat_booking_revenue: netCash - vat,
      };
    }),
    pagination: {
      page,
      pageSize,
      total: totalTransactions,
      totalPages: Math.max(1, Math.ceil(totalTransactions / pageSize)),
    },
  };
}

module.exports = {
  FinancialReportError,
  normalizePeriodFilters,
  computeOverlapNights,
  computePropertyPnl,
  classifyAndRankProperties,
  inferManagerWorkingMonths,
  calculateBonusSettlementRow,
  getChainFinancialOverview,
  getAccommodationFinancialDetail,
  upsertAccommodationMonthlyLedger,
  updateAccommodationOperatingProfile,
  getTetBonusAnd13thSalaryPreview,
  approveAndSaveBonusSettlements,
  sendFinancialWarningEmailToManager,
  getPaymentReconciliationLedger,
};
