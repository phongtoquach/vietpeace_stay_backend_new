const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { getDBPool, sqlObj: sql } = require('../configs/database');

const QR_CID = 'booking-qr@vietpeace-stay';
let transporter;

function getTransporter() {
    if (transporter) {
        return transporter;
    }

    const { SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;

    if (!SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
        throw Object.assign(
            new Error('Thiếu cấu hình Gmail SMTP.'),
            { code: 'INVALID_SMTP_CONFIG' }
        );
    }

    transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS,
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 30000,
    });

    return transporter;
}

async function loadConfirmationData(pool, bookingId) {
    const { recordsets } = await pool.request()
        .input('bookingId', sql.VarChar(19), bookingId)
        .query(`
            SELECT
                b.booking_code,
                b.contact_name,
                b.contact_email,
                b.contact_phone,
                b.is_booking_for_other,
                b.guest_name,
                b.guest_phone,
                b.guest_email,
                b.expected_arrival_time,
                b.special_requests,
                b.total_rooms,
                b.total_nights,
                b.total_adults,
                b.total_children,
                b.rooms_subtotal,
                b.extra_guest_total,
                b.room_discount_total,
                b.discount_amount,
                b.tax_amount,
                b.service_fee,
                b.total_amount,
                b.currency,
                CONVERT(CHAR(10), b.check_in_date, 23) AS checkin,
                CONVERT(CHAR(10), b.check_out_date, 23) AS checkout,
                a.accommodation_name,
                a.address_line,
                loc.name AS location_name,
                province.full_name AS loc_province_fullname,
                ward.full_name AS loc_ward_fullname
            FROM dbo.bookings AS b
            JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
            LEFT JOIN dbo.locations AS loc ON loc.id = a.location_id
            LEFT JOIN dbo.provinces AS province ON province.id = loc.province_id
            LEFT JOIN dbo.wards AS ward ON ward.id = a.ward_id
            WHERE b.id = CONVERT(BIGINT, @bookingId)
              AND b.status = 'CONFIRMED';

            SELECT
                CONVERT(VARCHAR(19), i.id) AS item_id,
                i.room_type_name,
                i.adults,
                i.children,
                i.room_subtotal,
                i.extra_adult_total,
                i.extra_child_total,
                i.discount_amount,
                i.total_amount
            FROM dbo.booking_items AS i
            WHERE i.booking_id = CONVERT(BIGINT, @bookingId)
            ORDER BY i.id;

            SELECT
                CONVERT(VARCHAR(19), n.booking_item_id) AS item_id,
                CONVERT(CHAR(10), n.stay_date, 23) AS stay_date,
                n.nightly_price
            FROM dbo.booking_item_nightly_rates AS n
            JOIN dbo.booking_items AS i ON i.id = n.booking_item_id
            WHERE i.booking_id = CONVERT(BIGINT, @bookingId)
            ORDER BY i.id, n.stay_date;
        `);

    const [bookings, rooms, nightlyRates] = recordsets;
    const booking = bookings[0];

    if (!booking) {
        return null;
    }

    const ratesByItem = new Map();

    for (const rate of nightlyRates) {
        if (!ratesByItem.has(rate.item_id)) {
            ratesByItem.set(rate.item_id, []);
        }

        ratesByItem.get(rate.item_id).push(rate);
    }

    return {
        booking,
        rooms: rooms.map(room => ({
            ...room,
            nightlyRates: ratesByItem.get(room.item_id) ?? [],
        })),
    };
}

function escapeHtml(value) {
    const entities = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    };

    return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

function readEmail(value) {
    const email = String(value ?? '').trim();

    return /^[^\s@<>,;:"\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)
        ? email
        : null;
}

function formatDate(value) {
    return value.split('-').reverse().join('/');
}

function isBookingForAnotherGuest(booking) {
    return booking.is_booking_for_other === true ||
        booking.is_booking_for_other === 1;
}

function buildConfirmationMessage({ booking, rooms }) {
    const money = new Intl.NumberFormat('vi-VN', {
        style: 'currency',
        currency: booking.currency,
    });

    const formatMoney = value => money.format(Number(value));
    const formatDiscount = value => {
        const amount = Number(value);
        return formatMoney(amount > 0 ? -amount : 0);
    };

    const forOther = isBookingForAnotherGuest(booking);

    const stayRows = [
        ['Cơ sở lưu trú', booking.accommodation_name],
        ['Điểm đến', booking.location_name],
        ['Địa chỉ', booking.address_line + ', ' + booking.loc_ward_fullname + ', ' + booking.loc_province_fullname],
        ['Nhận phòng', formatDate(booking.checkin)],
        ['Trả phòng', formatDate(booking.checkout)],
        ['Kỳ lưu trú', `${booking.total_nights} đêm · ${booking.total_rooms} phòng`],
        ['Số khách', `${booking.total_adults} người lớn · ${booking.total_children} trẻ em`],
        ['Người đặt phòng', booking.contact_name],
        ['Điện thoại liên hệ', booking.contact_phone],
        ['Khách đại diện', forOther ? booking.guest_name : null],
        ['Điện thoại khách đại diện', forOther ? booking.guest_phone : null],
        ['Giờ đến dự kiến', booking.expected_arrival_time],
        ['Yêu cầu đặc biệt', booking.special_requests],
    ].filter(([, value]) => value != null && value !== '');

    const totalRows = [
        ['Tiền phòng', formatMoney(booking.rooms_subtotal)],
        ['Phụ thu khách', formatMoney(booking.extra_guest_total)],
        //['Giảm giá theo phòng', formatDiscount(booking.room_discount_total)],
        //['Giảm giá đơn', formatDiscount(booking.discount_amount)],
        ['Thuế', formatMoney(booking.tax_amount)],
        //['Phí dịch vụ', formatMoney(booking.service_fee)],
        ['Tổng đã thanh toán', formatMoney(booking.total_amount)],
    ];

    const roomSections = rooms.map((room, index) => ({
        title: `Phòng ${index + 1} · ${room.room_type_name}`,
        rows: [
            ['Số khách', `${room.adults} người lớn · ${room.children} trẻ em`],
            ...room.nightlyRates.map(rate => [
                `Đêm ${formatDate(rate.stay_date)}`,
                formatMoney(rate.nightly_price),
            ]),
            ['Tiền phòng', formatMoney(room.room_subtotal)],
            ['Phụ thu người lớn', formatMoney(room.extra_adult_total)],
            ['Phụ thu trẻ em', formatMoney(room.extra_child_total)],
            //['Giảm giá phòng', formatDiscount(room.discount_amount)],
            ['Thành tiền phòng', formatMoney(room.total_amount)],
        ],
    }));

    function renderTable(rows, { highlightLast = false } = {}) {
        const content = rows.map(([label, value], index) => {
            const isLast = index === rows.length - 1;
            const highlight = highlightLast && isLast;
            const border = isLast ? 'none' : '1px solid #e7edf3';
            const background = highlight ? '#edf7f2' : '#ffffff';
            const valueColor = highlight ? '#146044' : '#18334a';

            return `
                <tr>
                    <th scope="row" align="left" valign="top"
                        style="width:44%;padding:11px 14px;border-bottom:${border};
                            background:${background};color:#536577;font-size:13px;
                            line-height:20px;font-weight:${highlight ? '700' : '400'};">
                        ${escapeHtml(label)}
                    </th>
                    <td align="right" valign="top"
                        style="padding:11px 14px;border-bottom:${border};
                            background:${background};color:${valueColor};
                            font-size:${highlight ? '17px' : '14px'};line-height:22px;
                            font-weight:700;overflow-wrap:anywhere;">
                        ${escapeHtml(value)}
                    </td>
                </tr>
            `;
        }).join('');

        return `
            <table width="100%" cellpadding="0" cellspacing="0"
                style="border-collapse:collapse;border:1px solid #e7edf3;">
                ${content}
            </table>
        `;
    }

    const code = escapeHtml(booking.booking_code);

    const html = `
        <div lang="vi" style="margin:0;padding:0;background:#eef3f7;
                            color:#18334a;font-family:Arial,sans-serif;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                    <td align="center" style="padding:24px 12px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                            style="max-width:640px;background:#ffffff;border:1px solid #dce5ed;">
                            <tr>
                                <td style="padding:28px 24px;background:#18334a;color:#ffffff;">
                                    <p style="margin:0 0 10px;color:#f4d38a;font-size:13px;
                                            font-weight:700;letter-spacing:1.5px;">
                                        VIETPEACE STAY
                                    </p>
                                    <h1 style="margin:0;font-size:28px;line-height:35px;">
                                        Đặt phòng đã được xác nhận
                                    </h1>
                                    <p style="margin:10px 0 0;color:#d8e5ef;font-size:14px;line-height:22px;">
                                        ${escapeHtml(booking.accommodation_name)}
                                        &nbsp;·&nbsp; ${escapeHtml(formatDate(booking.checkin))}
                                        – ${escapeHtml(formatDate(booking.checkout))}
                                    </p>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding:24px;">
                                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                                        style="background:#f7fafc;border:1px solid #dce5ed;">
                                        <tr>
                                            <td align="center" style="padding:20px 12px;">
                                                <p style="margin:0 0 8px;color:#536577;font-size:12px;
                                                        font-weight:700;letter-spacing:1px;">
                                                    MÃ ĐẶT PHÒNG
                                                </p>
                                                <p style="margin:0 0 12px;color:#18334a;font-size:23px;
                                                        line-height:30px;font-weight:700;overflow-wrap:anywhere;">
                                                    ${code}
                                                </p>
                                                <img src="cid:${QR_CID}" width="200" height="200"
                                                    alt="Mã QR đặt phòng ${code}"
                                                    style="display:block;width:200px;max-width:100%;
                                                            height:auto;margin:0 auto;border:0;">
                                                <p style="margin:12px 0 0;color:#536577;
                                                        font-size:13px;line-height:20px;">
                                                    Xuất trình mã QR hoặc đọc mã đặt phòng tại quầy lễ tân.
                                                </p>
                                            </td>
                                        </tr>
                                    </table>

                                    <h2 style="margin:28px 0 10px;color:#18334a;font-size:19px;">
                                        Thông tin lưu trú
                                    </h2>
                                    ${renderTable(stayRows)}

                                    <h2 style="margin:28px 0 10px;color:#18334a;font-size:19px;">
                                        Chi tiết phòng
                                    </h2>

                                    ${roomSections.map(room => `
                                        <table role="presentation" width="100%"
                                            cellpadding="0" cellspacing="0"
                                            style="margin-bottom:14px;">
                                            <tr>
                                                <td style="padding:10px 14px;background:#eaf0f6;
                                                        color:#18334a;font-size:14px;font-weight:700;">
                                                    ${escapeHtml(room.title)}
                                                </td>
                                            </tr>
                                            <tr>
                                                <td>${renderTable(room.rows, { highlightLast: true })}</td>
                                            </tr>
                                        </table>
                                    `).join('')}

                                    <h2 style="margin:24px 0 10px;color:#18334a;font-size:19px;">
                                        Chi tiết thanh toán
                                    </h2>
                                    ${renderTable(totalRows, { highlightLast: true })}
                                </td>
                            </tr>

                            <tr>
                                <td align="center" style="padding:18px 24px;background:#f7fafc;
                                                        border-top:1px solid #dce5ed;
                                                        color:#536577;font-size:13px;line-height:20px;">
                                    Cảm ơn quý khách đã lựa chọn VietPeace Stay.
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
    `;

    const asText = rows => rows.map(([label, value]) => `${label}: ${value}`);

    const text = [
        'VietPeace Stay | Đặt phòng đã được xác nhận',
        `Mã đặt phòng: ${booking.booking_code}`,
        'Vui lòng xuất trình mã QR hoặc đọc mã đặt phòng tại quầy lễ tân.',
        '',
        ...asText(stayRows),
        ...roomSections.flatMap(room => ['', room.title, ...asText(room.rows)]),
        '',
        'Chi tiết thanh toán',
        ...asText(totalRows),
    ].join('\n');

    return { html, text };
}

async function sendBookingConfirmation(bookingId) {
    const pool = await getDBPool();
    const data = await loadConfirmationData(pool, bookingId);

    if (!data) {
        throw Object.assign(
            new Error('Không tìm thấy booking đã xác nhận để gửi email.'),
            { code: 'CONFIRMED_BOOKING_NOT_FOUND' }
        );
    }

    const { booking, rooms } = data;
    const contactEmail = readEmail(booking.contact_email);

    if (!contactEmail) {
        throw Object.assign(
            new Error('Email liên hệ của booking không hợp lệ.'),
            { code: 'INVALID_CONTACT_EMAIL' }
        );
    }

    if (!rooms.length || rooms.length !== booking.total_rooms) {
        throw Object.assign(
            new Error('Thiếu chi tiết phòng để gửi email xác nhận.'),
            { code: 'INCOMPLETE_BOOKING_ROOMS' }
        );
    }

    const guestEmail = isBookingForAnotherGuest(booking)
        ? readEmail(booking.guest_email)
        : null;

    const bcc = guestEmail &&
        guestEmail.toLowerCase() !== contactEmail.toLowerCase()
        ? guestEmail
        : undefined;

    const qr = await QRCode.toBuffer(booking.booking_code, {
        type: 'png',
        width: 240,
        margin: 4,
        errorCorrectionLevel: 'M',
    });

    const { html, text } = buildConfirmationMessage(data);

    const info = await getTransporter().sendMail({
        from: process.env.MAIL_FROM,
        to: contactEmail,
        bcc,
        subject: `[VietPeace Stay] Xác nhận đặt phòng tại ${booking.accommodation_name}`,
        html,
        text,
        attachments: [{
            filename: 'booking-qr.png',
            content: qr,
            contentType: 'image/png',
            cid: QR_CID,
        }],
    });

    if (!info.accepted?.length || info.rejected?.length) {
        throw Object.assign(
            new Error('SMTP từ chối một hoặc nhiều địa chỉ nhận.'),
            { code: 'SMTP_RECIPIENT_REJECTED' }
        );
    }

    return info;
}

module.exports = { sendBookingConfirmation };