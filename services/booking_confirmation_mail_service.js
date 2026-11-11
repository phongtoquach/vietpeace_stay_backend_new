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
                a.address_line
            FROM dbo.bookings AS b
            JOIN dbo.accommodations AS a ON a.id = b.accommodation_id
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
        ['Địa chỉ', booking.address_line],
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

    function renderTable(rows) {
        const content = rows.map(([label, value]) => `
            <tr>
                <th
                    scope="row"
                    align="left"
                    style="padding:7px 10px;border-bottom:1px solid #E2E8F0"
                >
                    ${escapeHtml(label)}
                </th>
                <td style="padding:7px 10px;border-bottom:1px solid #E2E8F0">
                    ${escapeHtml(value)}
                </td>
            </tr>
        `).join('');

        return `
            <table width="100%" cellspacing="0" style="border-collapse:collapse">
                ${content}
            </table>
        `;
    }

    const code = escapeHtml(booking.booking_code);

    const html = `
        <div
            lang="vi"
            style="max-width:640px;margin:auto;padding:24px;color:#233B53;font:15px Arial,sans-serif"
        >
            <h1>Đặt phòng đã được xác nhận</h1>
            <p>Cảm ơn quý khách đã đặt phòng tại VietPeace Stay.</p>

            <div
                style="text-align:center;padding:16px;background:#F8FAFC;border:1px solid #E2E8F0"
            >
                <p>Mã đặt phòng</p>
                <p style="font-size:20px;font-weight:bold">${code}</p>
                <img
                    src="cid:${QR_CID}"
                    width="240"
                    height="240"
                    alt="Mã QR đặt phòng ${code}"
                >
                <p>Vui lòng xuất trình mã QR hoặc đọc mã đặt phòng tại quầy lễ tân.</p>
            </div>

            <h2>Thông tin lưu trú</h2>
            ${renderTable(stayRows)}

            <h2>Chi tiết phòng</h2>
            ${roomSections.map(room => `
                <h3>${escapeHtml(room.title)}</h3>
                ${renderTable(room.rows)}
            `).join('')}

            <h2>Chi tiết thanh toán</h2>
            ${renderTable(totalRows)}
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
        subject: `[VietPeace Stay] Xác nhận đặt phòng ${booking.booking_code}`,
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