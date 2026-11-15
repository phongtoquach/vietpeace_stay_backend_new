const nodemailer = require("nodemailer");

/**
 * Cấu hình Transporter gửi email
 * Hỗ trợ gửi thật qua Gmail với Mật khẩu ứng dụng (App Password)
 */
function getTransporter() {
    const user = process.env.SMTP_USER?.trim();
    const rawPass = process.env.SMTP_PASS?.trim();
    // Tự động gỡ khoảng trắng nếu copy nguyên cụm 4 chữ cái từ Google App Password
    const pass = rawPass ? rawPass.replace(/\s+/g, "") : null;

    if (!user || !pass) {
        return null;
    }

    if (process.env.SMTP_HOST) {
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: { user, pass },
        });
    }

    // Cấu hình chuẩn của Gmail
    return nodemailer.createTransport({
        service: "gmail",
        auth: { user, pass },
    });
}

/**
 * Gửi email thông tin tài khoản nội bộ & mật khẩu tạm thời đến Gmail cá nhân
 * Giao diện Email chuẩn nhận diện thương hiệu VietPeace Stay Hospitality
 */
async function sendAccountProvisionEmail({
    toGmail,
    fullName,
    roleTitle,
    accommodationName,
    internalEmail,
    temporaryPassword,
}) {
    const adminUrl = process.env.ADMIN_PANEL_DOMAIN || "http://localhost:5175";
    const login = new URL('/login', adminUrl);
    login.searchParams.set('email', internalEmail);
    const loginUrl = login.toString();

    const subject = `[VietPeace Stay] Bàn giao tài khoản quản trị: ${accommodationName}`;

    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 620px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
            
            <!-- Header dải màu nhận diện thương hiệu vàng đồng sang trọng VietPeace Stay -->
            <div style="background: linear-gradient(135deg, #78350F 0%, #B45309 45%, #D97706 100%); color: #ffffff; padding: 28px 24px; text-align: center;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">VIETPEACE STAY HOSPITALITY</h1>
                <p style="margin: 6px 0 0; font-size: 13.5px; color: #FEF3C7; opacity: 0.95; font-weight: 500;">HỆ THỐNG QUẢN TRỊ & VẬN HÀNH NGHỈ DƯỠNG NỘI BỘ</p>
            </div>

            <div style="padding: 28px 24px;">
                <p style="margin-top: 0; font-size: 15px;">Xin chào <strong>${fullName}</strong>,</p>
                <p style="font-size: 14.5px; color: #374151;">
                    Bạn đã được chỉ định vào vị trí <strong>${roleTitle}</strong> phụ trách cơ sở lưu trú: <strong style="color: #78350F;">${accommodationName}</strong>.
                </p>
                
                <!-- Khung thông tin tài khoản đăng nhập -->
                <div style="background-color: #FFFDF7; border: 1.5px dashed #D97706; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="margin-top: 0; margin-bottom: 14px; color: #92400E; font-size: 16px; border-bottom: 1px solid #FDE68A; padding-bottom: 8px;">
                        🔑 Thông tin tài khoản đăng nhập nội bộ:
                    </h3>
                    
                    <p style="margin: 8px 0 14px; font-size: 14px;">
                        <strong>Đường dẫn truy cập:</strong> <a href="${loginUrl}" style="color: #0284C7; text-decoration: underline;">${adminUrl}</a>
                    </p>

                    <!-- Hàng: Tài khoản nội bộ -->
                    <div style="margin-bottom: 12px; background-color: #FFFFFF; border: 1px solid #CBD5E1; border-radius: 6px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                        <div style="font-size: 11.5px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                            👤 Tài khoản nội bộ (Username)
                        </div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 15px; font-weight: 700; color: #0F172A; user-select: all; -webkit-user-select: all; word-break: break-all;">
                            ${internalEmail}
                        </div>
                    </div>

                    <!-- Hàng: Mật khẩu tạm thời -->
                    <div style="margin-bottom: 20px; background-color: #FFFDF0; border: 1px solid #FCD34D; border-radius: 6px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                        <div style="font-size: 11.5px; font-weight: 700; color: #92400E; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                            🔑 Mật khẩu tạm thời
                        </div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 16px; font-weight: 800; color: #78350F; letter-spacing: 0.5px; user-select: all; -webkit-user-select: all; word-break: break-all;">
                            ${temporaryPassword}
                        </div>
                    </div>

                    <div style="text-align: center;">
                        <a href="${loginUrl}" style="background-color: #F4C542; color: #24220A; text-decoration: none; font-weight: bold; font-size: 14px; padding: 11px 26px; border-radius: 6px; display: inline-block; border: 1px solid #D6A82C; box-shadow: 0 2px 4px rgba(0,0,0,0.06);">
                            Đăng nhập vào Hệ thống Quản trị &rarr;
                        </a>
                    </div>
                </div>

                <!-- Hộp lưu ý bảo mật mật khẩu tạm -->
                <div style="background-color: #FFFBEB; border-left: 4px solid #F59E0B; padding: 14px 16px; margin-bottom: 24px; border-radius: 0 6px 6px 0;">
                    <p style="margin: 0; font-size: 13.5px; color: #92400E; line-height: 1.5;">
                        <strong>Lưu ý bảo mật quan trọng:</strong> Đây là mật khẩu tạm thời. Khi đăng nhập lần đầu tiên vào hệ thống, bạn bắt buộc phải thiết lập lại mật khẩu mới để kích hoạt tài khoản quản trị.
                    </p>
                </div>

                <p style="font-size: 13px; color: #64748B; margin-bottom: 0;">
                    Nếu bạn có thắc mắc hoặc cần trợ giúp kỹ thuật, vui lòng liên hệ Quản trị viên cấp cao của hệ thống.
                </p>
            </div>

            <!-- Footer chân trang -->
            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 16px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email này được tạo tự động bởi hệ thống quản trị nội bộ, vui lòng không trả lời thư này.
            </div>
        </div>
    `;

    const transporter = getTransporter();

    // Nếu có cấu hình SMTP -> gửi email thật qua Gmail
    if (transporter) {
        try {
            const info = await transporter.sendMail({
                from: `"VietPeace Stay System" <${process.env.SMTP_USER}>`,
                to: toGmail,
                subject: subject,
                html: htmlContent,
            });
            if (!info.accepted?.some(address => String(address).toLowerCase() === toGmail.toLowerCase())) {
                return { success: false, method: "smtp_rejected" };
            }
            return { success: true, method: "smtp" };
        } catch (error) {
            console.error("[MailService] Gửi thư bàn giao thất bại:", error.code || "SMTP_ERROR");
            return { success: false, method: "smtp_error" };
        }
    }

    return { success: false, method: "smtp_not_configured" };
}

/**
 * Gửi email thông báo cấp lại mật khẩu mới từ Quản trị viên cấp cao
 */
async function sendPasswordResetEmail({
    toGmail,
    fullName,
    accommodationName,
    internalEmail,
    newPassword,
}) {
    const adminUrl = process.env.ADMIN_PANEL_DOMAIN || "http://localhost:5175/login";
    const loginUrl = `${adminUrl}?email=${encodeURIComponent(internalEmail)}`;
    const subject = `[VietPeace Stay] Cấp lại mật khẩu tài khoản quản trị${accommodationName ? `: ${accommodationName}` : ""}`;

    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 620px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
            
            <!-- Header dải màu nhận diện thương hiệu vàng đồng sang trọng VietPeace Stay -->
            <div style="background: linear-gradient(135deg, #78350F 0%, #B45309 45%, #D97706 100%); color: #ffffff; padding: 28px 24px; text-align: center;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">VIETPEACE STAY HOSPITALITY</h1>
                <p style="margin: 6px 0 0; font-size: 13.5px; color: #FEF3C7; opacity: 0.95; font-weight: 500;">THÔNG BÁO CẤP LẠI MẬT KHẨU QUẢN TRỊ</p>
            </div>

            <div style="padding: 28px 24px;">
                <p style="margin-top: 0; font-size: 15px;">Xin chào <strong>${fullName}</strong>,</p>
                <p style="font-size: 14.5px; color: #374151;">
                    Quản trị viên cấp cao vừa thực hiện đặt lại mật khẩu tạm thời cho tài khoản quản trị của bạn${accommodationName ? ` tại cơ sở <strong style="color: #78350F;">${accommodationName}</strong>` : ""}.
                </p>
                
                <!-- Khung thông tin đăng nhập mới -->
                <div style="background-color: #FFFDF7; border: 1.5px dashed #D97706; border-radius: 8px; padding: 20px; margin: 24px 0;">
                    <h3 style="margin-top: 0; margin-bottom: 14px; color: #92400E; font-size: 16px; border-bottom: 1px solid #FDE68A; padding-bottom: 8px;">
                        🔑 Thông tin đăng nhập mới của bạn:
                    </h3>
                    
                    <p style="margin: 8px 0 14px; font-size: 14px;">
                        <strong>Đường dẫn truy cập:</strong> <a href="${loginUrl}" style="color: #0284C7; text-decoration: underline;">${adminUrl}</a>
                    </p>

                    <!-- Hàng: Tài khoản nội bộ -->
                    <div style="margin-bottom: 12px; background-color: #FFFFFF; border: 1px solid #CBD5E1; border-radius: 6px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                        <div style="font-size: 11.5px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                            👤 Tài khoản nội bộ (Username)
                        </div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 15px; font-weight: 700; color: #0F172A; user-select: all; -webkit-user-select: all; word-break: break-all;">
                            ${internalEmail}
                        </div>
                    </div>

                    <!-- Hàng: Mật khẩu tạm thời mới -->
                    <div style="margin-bottom: 20px; background-color: #FFFDF0; border: 1px solid #FCD34D; border-radius: 6px; padding: 12px 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.03);">
                        <div style="font-size: 11.5px; font-weight: 700; color: #92400E; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">
                            🔑 Mật khẩu tạm thời mới
                        </div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 16px; font-weight: 800; color: #78350F; letter-spacing: 0.5px; user-select: all; -webkit-user-select: all; word-break: break-all;">
                            ${newPassword}
                        </div>
                    </div>

                    <div style="text-align: center;">
                        <a href="${loginUrl}" style="background-color: #F4C542; color: #24220A; text-decoration: none; font-weight: bold; font-size: 14px; padding: 11px 26px; border-radius: 6px; display: inline-block; border: 1px solid #D6A82C; box-shadow: 0 2px 4px rgba(0,0,0,0.06);">
                            Đăng nhập và Đổi mật khẩu &rarr;
                        </a>
                    </div>
                </div>

                <!-- Hộp lưu ý bảo mật -->
                <div style="background-color: #FFFBEB; border-left: 4px solid #F59E0B; padding: 14px 16px; margin-bottom: 24px; border-radius: 0 6px 6px 0;">
                    <p style="margin: 0; font-size: 13.5px; color: #92400E; line-height: 1.5;">
                        <strong>Lưu ý bảo mật quan trọng:</strong> Ngay khi đăng nhập bằng mật khẩu tạm thời mới này, hệ thống sẽ yêu cầu bạn thiết lập lại mật khẩu cá nhân mới để đảm bảo an toàn.
                    </p>
                </div>

                <p style="font-size: 13px; color: #64748B; margin-bottom: 0;">
                    Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng liên hệ ngay với Quản trị viên cấp cao của hệ thống.
                </p>
            </div>

            <!-- Footer chân trang -->
            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 16px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email này được tạo tự động bởi hệ thống quản trị nội bộ, vui lòng không trả lời thư này.
            </div>
        </div>
    `;

    const transporter = getTransporter();

    if (transporter) {
        try {
            await transporter.sendMail({
                from: `"VietPeace Stay System" <${process.env.SMTP_USER}>`,
                to: toGmail,
                subject: subject,
                html: htmlContent,
            });
            console.log(`[MailService] Đã gửi email cấp lại mật khẩu THẬT thành công đến: ${toGmail}`);
            return { success: true, method: "smtp" };
        } catch (error) {
            console.error(`[MailService] Gửi email cấp lại mật khẩu thất bại:`, error.message || error);
            return { success: false, method: "smtp_error", error: error.message };
        }
    }

    console.log("\n=======================================================");
    console.log("📨 [CONSOLE LOG] CẤP LẠI MẬT KHẨU NỘI BỘ (Chưa có SMTP)");
    console.log(`Đến Gmail: ${toGmail}`);
    console.log(`Tài khoản nội bộ: ${internalEmail}`);
    console.log(`Mật khẩu tạm thời mới: ${newPassword}`);
    console.log(`Đường link Admin: ${loginUrl}`);
    console.log("=======================================================\n");

    return { success: true, method: "dev_log" };
}

function escapeMailHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatMailVnd(value) {
    return `${new Intl.NumberFormat("vi-VN").format(Math.round(Number(value || 0)))} đ`;
}

/**
 * Gửi Gmail cảnh báo tài chính & yêu cầu giải trình tới Manager cơ sở yếu/âm lợi nhuận
 */
async function sendManagerFinancialWarningEmail({
    toGmail,
    managerName,
    accommodationName,
    periodLabel,
    totalRevenue,
    totalExpenses,
    netProfitAfterTax,
    warningType,
    adminNote,
}) {
    const adminUrl = process.env.ADMIN_PANEL_DOMAIN || "http://localhost:5175";
    const reportUrl = new URL("/admin/reports/revenue", adminUrl).toString();
    const isNegative = warningType === "NEGATIVE_PROFIT" || Number(netProfitAfterTax) < 0;
    const badgeLabel = isNegative
        ? "CẢNH BÁO ĐỎ — ÂM LỢI NHUẬN"
        : warningType === "ZERO_REVENUE"
            ? "CẢNH BÁO VÀNG — CHƯA PHÁT SINH DOANH THU"
            : "CẢNH BÁO VÀNG — BIÊN LỢI NHUẬN MỎNG (< 5%)";
    const badgeBg = isNegative ? "#FEE2E2" : "#FEF3C7";
    const badgeColor = isNegative ? "#991B1B" : "#92400E";
    const profitColor = Number(netProfitAfterTax) < 0 ? "#B91C1C" : "#92400E";

    const subject = `[VietPeace Stay] Cảnh báo hiệu suất tài chính (${periodLabel}) — ${accommodationName}`;
    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 640px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
            <div style="background: linear-gradient(135deg, #78350F 0%, #B45309 45%, #D97706 100%); color: #ffffff; padding: 24px; text-align: center;">
                <h1 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;">VIETPEACE STAY HOSPITALITY</h1>
                <p style="margin: 6px 0 0; font-size: 13px; color: #FEF3C7;">THÔNG BÁO CẢNH BÁO HIỆU SUẤT TÀI CHÍNH CƠ SỞ</p>
            </div>
            <div style="padding: 24px;">
                <div style="display: inline-block; padding: 6px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; background: ${badgeBg}; color: ${badgeColor}; margin-bottom: 14px;">
                    ${escapeMailHtml(badgeLabel)}
                </div>
                <p style="margin: 0 0 12px;">Kính gửi Quản lý <strong>${escapeMailHtml(managerName || "Quản lý cơ sở")}</strong>,</p>
                <p style="margin: 0 0 16px;">Ban Điều hành VietPeace Stay ghi nhận kết quả kinh doanh kỳ <strong>${escapeMailHtml(periodLabel)}</strong> của cơ sở <strong>${escapeMailHtml(accommodationName)}</strong> đang cần rà soát và có phương án cải thiện kịp thời:</p>

                <table style="width: 100%; border-collapse: collapse; margin-bottom: 18px; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                    <tr style="background: #F9FAFB;">
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px; color: #4B5563;">Tổng Thu ròng (Pre-VAT + Dịch vụ phụ trợ)</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 14px; font-weight: 700; text-align: right; color: #0F172A;">${formatMailVnd(totalRevenue)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px; color: #4B5563;">Tổng Chi vận hành (OPEX)</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 14px; font-weight: 700; text-align: right; color: #0F172A;">${formatMailVnd(totalExpenses)}</td>
                    </tr>
                    <tr style="background: #FEF2F2;">
                        <td style="padding: 10px 14px; font-size: 13.5px; font-weight: 700; color: #374151;">Lợi nhuận thuần sau thuế</td>
                        <td style="padding: 10px 14px; font-size: 15px; font-weight: 800; text-align: right; color: ${profitColor};">${formatMailVnd(netProfitAfterTax)}</td>
                    </tr>
                </table>

                <div style="background: #FFFBEB; border-left: 4px solid #D97706; padding: 14px 16px; border-radius: 6px; margin-bottom: 18px;">
                    <div style="font-size: 12.5px; font-weight: 700; color: #92400E; margin-bottom: 6px;">CHỈ ĐẠO & YÊU CẦU GIẢI TRÌNH TỪ ADMIN:</div>
                    <div style="font-size: 13.5px; color: #292D32; white-space: pre-line;">${escapeMailHtml(adminNote)}</div>
                </div>

                <div style="text-align: center; margin: 22px 0 10px;">
                    <a href="${reportUrl}" style="display: inline-block; background: #B45309; color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 11px 22px; border-radius: 8px;">Mở Trung tâm Báo cáo Tài chính</a>
                </div>
            </div>
            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 14px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email thông báo quản trị nội bộ, vui lòng phản hồi báo cáo qua kênh điều hành.
            </div>
        </div>
    `;

    const transporter = getTransporter();
    if (transporter) {
        try {
            await transporter.sendMail({
                from: `"VietPeace Stay Finance" <${process.env.SMTP_USER}>`,
                to: toGmail,
                subject,
                html: htmlContent,
            });
            return { success: true, method: "smtp" };
        } catch (error) {
            console.error("[MailService] Gửi email cảnh báo tài chính thất bại:", error.message || error);
            return { success: false, method: "smtp_error", error: error.message || "SMTP_SEND_ERROR" };
        }
    }

    console.log("\n=======================================================");
    console.log("📨 [DEV LOG] GMAIL CẢNH BÁO TÀI CHÍNH MANAGER");
    console.log(`Đến Gmail: ${toGmail} | Manager: ${managerName} | Cơ sở: ${accommodationName}`);
    console.log(`Kỳ: ${periodLabel} | Thu: ${formatMailVnd(totalRevenue)} | Chi: ${formatMailVnd(totalExpenses)} | LN: ${formatMailVnd(netProfitAfterTax)}`);
    console.log(`Ghi chú Admin: ${adminNote}`);
    console.log("=======================================================\n");
    return { success: true, method: "dev_log" };
}

/**
 * Gửi Gmail chúc mừng & thông báo quyết toán Thưởng Top / Lương Tháng 13 / Thưởng Tết tới Manager
 */
async function sendManagerBonusAndTetRewardEmail({
    toGmail,
    managerName,
    accommodationName,
    periodLabel,
    performanceTier,
    rankingPosition,
    topBonusRatePercent,
    manager13thSalary,
    managerTetBonus,
    staff13thSalaryPool,
    staffTetBonusPool,
    staffHeadcount,
    totalPayoutAmount,
    adminNote,
}) {
    const tierText = rankingPosition && rankingPosition <= 3
        ? `Top ${rankingPosition} (${Number(topBonusRatePercent || 0)}% Lợi nhuận)`
        : performanceTier === "PROFITABLE"
            ? `Cơ sở đạt chuẩn hiệu quả (${Number(topBonusRatePercent || 0)}%)`
            : "Quyết toán cuối năm";

    const subject = `[VietPeace Stay] Thông báo Quyết toán Thưởng & Lương T13 (${periodLabel}) — ${accommodationName}`;
    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 640px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
            <div style="background: linear-gradient(135deg, #78350F 0%, #B45309 45%, #D97706 100%); color: #ffffff; padding: 24px; text-align: center;">
                <h1 style="margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase;">VIETPEACE STAY HOSPITALITY</h1>
                <p style="margin: 6px 0 0; font-size: 13px; color: #FEF3C7;">QUYẾT TOÁN LƯƠNG THÁNG 13 & THƯỞNG HIỆU SUẤT (${escapeMailHtml(periodLabel)})</p>
            </div>
            <div style="padding: 24px;">
                <p style="margin: 0 0 12px;">Kính gửi Quản lý <strong>${escapeMailHtml(managerName || "Quản lý cơ sở")}</strong>,</p>
                <p style="margin: 0 0 16px;">Ban Giám đốc VietPeace Stay trân trọng thông báo bảng quyết toán lương tháng 13 & thưởng hiệu suất đã được phê duyệt cho cơ sở <strong>${escapeMailHtml(accommodationName)}</strong> (${escapeMailHtml(tierText)}):</p>

                <table style="width: 100%; border-collapse: collapse; margin-bottom: 18px; border: 1px solid #E5E7EB;">
                    <tr style="background: #FFFBEB;">
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px;">Lương Tháng 13 của Manager</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-weight: 700; text-align: right;">${formatMailVnd(manager13thSalary)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px;">Thưởng hiệu suất / Thưởng Tết Manager (40% quỹ thưởng)</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-weight: 700; text-align: right; color: #B45309;">${formatMailVnd(managerTetBonus)}</td>
                    </tr>
                    <tr style="background: #F9FAFB;">
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px;">Quỹ Lương Tháng 13 Tập thể Nhân viên (${Number(staffHeadcount || 0)} nhân sự)</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-weight: 700; text-align: right;">${formatMailVnd(staff13thSalaryPool)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-size: 13.5px;">Quỹ Thưởng Tết Tập thể Nhân viên (60% quỹ thưởng)</td>
                        <td style="padding: 10px 14px; border-bottom: 1px solid #E5E7EB; font-weight: 700; text-align: right; color: #15803D;">${formatMailVnd(staffTetBonusPool)}</td>
                    </tr>
                    <tr style="background: #ECFDF5;">
                        <td style="padding: 12px 14px; font-weight: 700; font-size: 14px; color: #065F46;">TỔNG QUỸ CHI QUYẾT TOÁN CƠ SỞ</td>
                        <td style="padding: 12px 14px; font-weight: 800; font-size: 16px; text-align: right; color: #047857;">${formatMailVnd(totalPayoutAmount)}</td>
                    </tr>
                </table>

                ${adminNote ? `<div style="background: #F8FAFC; border-left: 4px solid #B45309; padding: 12px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13.5px;"><strong>Ghi chú từ Ban Điều hành:</strong><br/>${escapeMailHtml(adminNote)}</div>` : ""}
                <p style="font-size: 13px; color: #4B5563; margin: 0;">Cảm ơn những đóng góp của anh/chị và toàn thể đội ngũ cơ sở trong suốt năm qua!</p>
            </div>
            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 14px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email thông báo tài chính – nhân sự nội bộ.
            </div>
        </div>
    `;

    const transporter = getTransporter();
    if (transporter) {
        try {
            await transporter.sendMail({
                from: `"VietPeace Stay Finance" <${process.env.SMTP_USER}>`,
                to: toGmail,
                subject,
                html: htmlContent,
            });
            return { success: true, method: "smtp" };
        } catch (error) {
            console.error("[MailService] Gửi email thưởng/T13 thất bại:", error.message || error);
            return { success: false, method: "smtp_error", error: error.message || "SMTP_SEND_ERROR" };
        }
    }

    console.log("\n=======================================================");
    console.log("📨 [DEV LOG] GMAIL QUYẾT TOÁN LƯƠNG T13 & THƯỞNG TẾT");
    console.log(`Đến Gmail: ${toGmail} | Manager: ${managerName} | Cơ sở: ${accommodationName}`);
    console.log(`Tổng chi: ${formatMailVnd(totalPayoutAmount)}`);
    console.log("=======================================================\n");
    return { success: true, method: "dev_log" };
}

/**
 * Gửi email cảnh báo chất lượng CSKH khi đánh giá chat 1-3 sao được xác nhận vi phạm
 */
async function sendChatCskhWarningEmail({
    toGmail,
    managerName,
    accommodationName,
    rating,
    customerComment,
    adminNote,
    customSubject,
    customBody,
}) {
    const adminUrl = process.env.ADMIN_PANEL_DOMAIN || "http://localhost:5175";
    const subject =
        (customSubject && String(customSubject).trim()) ||
        `[VietPeace Stay CSKH] Cảnh cáo chất lượng tư vấn (${rating}/5 sao) — ${accommodationName}`;
    const safeName = escapeMailHtml(managerName || "Quản lý cơ sở");
    const safeAccom = escapeMailHtml(accommodationName || "Cơ sở lưu trú");
    const safeComment = escapeMailHtml(customerComment || "(Khách không để lại nhận xét thêm)");
    const safeNote = escapeMailHtml(adminNote || "Vui lòng rà soát tốc độ phản hồi và thái độ phục vụ khách trên hệ thống Chat.");
    const safeCustomBody = customBody ? escapeMailHtml(customBody).replace(/\r?\n/g, "<br />") : null;

    const bodySectionHtml = safeCustomBody
        ? `
                <div style="background-color: #FEF2F2; border-left: 4px solid #C0392B; padding: 14px 16px; border-radius: 6px; margin: 14px 0; color: #1F2937;">
                    ${safeCustomBody}
                </div>
            `
        : `
                <p style="margin-top: 0;">Xin chào <strong>${safeName}</strong>,</p>
                <p>Hệ thống vừa ghi nhận một đánh giá <strong>${Number(rating)}/5 sao</strong> đối với phiên tư vấn trực tuyến tại cơ sở <strong>${safeAccom}</strong> đã được Quản trị viên xác nhận cần rút kinh nghiệm:</p>
                <div style="background-color: #FFF9ED; border-left: 4px solid #F5B82E; padding: 12px 14px; border-radius: 6px; margin: 16px 0;">
                    <div style="font-size: 12px; font-weight: 700; color: #92400E; margin-bottom: 4px;">PHẢN HỒI CỦA KHÁCH HÀNG</div>
                    <div style="color: #1F2937;">${safeComment}</div>
                </div>
                <div style="background-color: #FEF2F2; border-left: 4px solid #C0392B; padding: 12px 14px; border-radius: 6px; margin: 16px 0;">
                    <div style="font-size: 12px; font-weight: 700; color: #991B1B; margin-bottom: 4px;">CHỈ ĐẠO TỪ QUẢN TRỊ VIÊN</div>
                    <div style="color: #1F2937;">${safeNote}</div>
                </div>
            `;

    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 620px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff;">
            <div style="background: linear-gradient(135deg, #233B53 0%, #172A3C 100%); color: #ffffff; padding: 24px; text-align: center; border-bottom: 3px solid #F5B82E;">
                <h1 style="margin: 0; font-size: 20px; font-weight: 800;">VIETPEACE STAY CSKH</h1>
                <p style="margin: 6px 0 0; font-size: 13px; color: #FFF1C2;">THƯ CẢNH CÁO &amp; NHẮC NHỞ CHẤT LƯỢNG TƯ VẤN KHÁCH HÀNG</p>
            </div>
            <div style="padding: 24px;">
                ${bodySectionHtml}
                <div style="text-align: center; margin-top: 22px;">
                    <a href="${adminUrl}/chat" style="background-color: #F4C542; color: #24220A; text-decoration: none; font-weight: 700; font-size: 14px; padding: 10px 24px; border-radius: 6px; display: inline-block;">
                        Mở Trung tâm CSKH VietPeace Stay &rarr;
                    </a>
                </div>
            </div>
        </div>
    `;

    const transporter = getTransporter();
    if (transporter) {
        const delivery = await transporter.sendMail({
            from: process.env.MAIL_FROM || `"VietPeace Stay CSKH" <${process.env.SMTP_USER}>`,
            to: toGmail,
            subject,
            text: customBody ? String(customBody) : undefined,
            html: htmlContent,
        });
        const recipient = String(toGmail || "").trim().toLowerCase();
        const accepted = delivery?.accepted?.some(address => String(address?.address || address).trim().toLowerCase() === recipient);
        if (!accepted) return { success: false, method: "smtp_rejected", error: "SMTP không chấp nhận người nhận email cảnh báo." };
        return { success: true, method: "smtp" };
    }

    return { success: false, method: "smtp_not_configured", error: "Chưa cấu hình SMTP gửi email cảnh báo." };
}

async function sendTransactionalHtmlMail({
    toEmail,
    subject,
    textContent,
    htmlContent,
    logContext = "email",
}) {
    const transporter = getTransporter();

    if (!transporter) {
        console.warn(`[MailService] Chưa cấu hình SMTP nên không thể gửi ${logContext} đến ${toEmail}`);
        return { success: false, method: "smtp_not_configured" };
    }

    try {
        const info = await transporter.sendMail({
            from: process.env.MAIL_FROM?.trim() || `"VietPeace Stay" <${process.env.SMTP_USER}>`,
            to: toEmail,
            subject,
            text: textContent,
            html: htmlContent,
        });
        if (!info.accepted?.some((address) => String(address).toLowerCase() === String(toEmail).toLowerCase())) {
            return { success: false, method: "smtp_rejected" };
        }
        return { success: true, method: "smtp" };
    } catch (error) {
        console.error(`[MailService] Gửi ${logContext} thất bại:`, error.code || error.message || "SMTP_ERROR");
        return { success: false, method: "smtp_error", error: error.message || "SMTP_SEND_ERROR" };
    }
}

function getWebLoginBaseUrl() {
    return (process.env.WEB_DOMAIN || "http://localhost:5178")
        .trim()
        .replace(/^["']|["']$/g, "");
}

/**
 * Gửi email mã xác nhận kích hoạt cho lần đăng nhập đầu tiên của khách hàng
 */
async function sendCustomerVerificationEmail({
    toEmail,
    fullName,
    verificationCode,
    verificationUrl,
    expiresInHours = 24,
}) {
    const safeName = escapeMailHtml(fullName || "Quý khách");
    const safeEmail = escapeMailHtml(toEmail || "");
    const safeCode = escapeMailHtml(verificationCode || "");
    const hours = Number(expiresInHours) || 24;
    const loginUrlObj = new URL("/login", getWebLoginBaseUrl());
    if (toEmail) loginUrlObj.searchParams.set("email", toEmail);
    if (verificationCode) loginUrlObj.searchParams.set("verify", "1");
    const safeLoginUrl = escapeMailHtml(verificationUrl || loginUrlObj.toString());

    const subject = verificationCode
        ? "[VietPeace Stay] Mã xác nhận kích hoạt tài khoản đăng nhập lần đầu"
        : "[VietPeace Stay] Xác thực địa chỉ email tài khoản của bạn";

    const textContent = verificationCode
        ? [
            `Xin chào ${fullName || "Quý khách"},`,
            "",
            "Tài khoản khách hàng tại VietPeace Stay của bạn đã được tạo thành công.",
            `Tên đăng nhập: ${toEmail}`,
            `Mã xác nhận đăng nhập lần đầu: ${verificationCode}`,
            "",
            `Khi đăng nhập lần đầu tiên, vui lòng nhập mã xác nhận trên để kích hoạt tài khoản (có hiệu lực trong ${hours} giờ).`,
            "Từ những lần đăng nhập sau, bạn sẽ không cần nhập lại mã này.",
            `Đăng nhập tại: ${loginUrlObj.toString()}`,
        ].join("\n")
        : [
            `Xin chào ${fullName || "Quý khách"},`,
            "",
            "Cảm ơn bạn đã đăng ký tài khoản tại VietPeace Stay.",
            `Vui lòng truy cập liên kết sau để xác thực email và kích hoạt tài khoản (có hiệu lực trong ${hours} giờ):`,
            verificationUrl,
            "",
            "Nếu bạn không thực hiện đăng ký tài khoản này, vui lòng bỏ qua email này.",
        ].join("\n");

    const verificationBoxHtml = verificationCode
        ? `
                <div style="background-color: #FFFDF7; border: 1.5px dashed #D97706; border-radius: 10px; padding: 22px 20px; margin: 24px 0; text-align: center;">
                    <div style="font-size: 12px; font-weight: 700; color: #92400E; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 10px;">
                        Mã xác nhận kích hoạt tài khoản
                    </div>
                    <div style="display: inline-block; background-color: #FFFFFF; border: 1px solid #FCD34D; border-radius: 8px; padding: 12px 24px; font-family: Consolas, 'Courier New', monospace; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #0F172A; user-select: all; -webkit-user-select: all;">
                        ${safeCode}
                    </div>
                    <p style="margin: 14px 0 0; font-size: 13px; color: #4B5563;">
                        Tên đăng nhập của bạn là email <strong>${safeEmail}</strong>.<br/>
                        Mã chỉ sử dụng ở <strong>lần đăng nhập đầu tiên</strong> và có hiệu lực trong vòng <strong>${hours} giờ</strong>.
                    </p>
                    <div style="margin-top: 16px;">
                        <a href="${safeLoginUrl}" style="background-color: #F5B82E; color: #0F172A; text-decoration: none; font-weight: 800; font-size: 14.5px; padding: 11px 24px; border-radius: 8px; display: inline-block; border: 1px solid #D99B16;">
                            Đi tới trang Đăng nhập &rarr;
                        </a>
                    </div>
                </div>
        `
        : `
                <div style="background-color: #FFFDF7; border: 1px solid #FDE68A; border-radius: 8px; padding: 22px 20px; margin: 24px 0; text-align: center;">
                    <a href="${safeLoginUrl}" style="background-color: #F5B82E; color: #173B2B; text-decoration: none; font-weight: 800; font-size: 15px; padding: 13px 28px; border-radius: 8px; display: inline-block; border: 1px solid #D99B16;">
                        Xác thực Email ngay &rarr;
                    </a>
                    <p style="margin: 14px 0 0; font-size: 12.5px; color: #6B7280;">
                        Liên kết xác thực có hiệu lực trong vòng <strong>${hours} giờ</strong> và chỉ sử dụng một lần.
                    </p>
                </div>
        `;

    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 620px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
            <div style="background: linear-gradient(135deg, #173B2B 0%, #233B53 100%); color: #ffffff; padding: 28px 24px; text-align: center; border-bottom: 3px solid #F5B82E;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">VIETPEACE STAY</h1>
                <p style="margin: 6px 0 0; font-size: 13.5px; color: #FEF3C7; opacity: 0.95; font-weight: 500;">XÁC NHẬN KÍCH HOẠT TÀI KHOẢN KHÁCH HÀNG</p>
            </div>

            <div style="padding: 28px 24px;">
                <p style="margin-top: 0; font-size: 15px;">Xin chào <strong>${safeName}</strong>,</p>
                <p style="font-size: 14.5px; color: #374151;">
                    Cảm ơn bạn đã đăng ký tài khoản thành viên tại <strong>VietPeace Stay</strong> với email <strong>${safeEmail}</strong>.
                    ${verificationCode
                        ? "Để bảo mật và kích hoạt tài khoản trong lần đăng nhập đầu tiên, vui lòng nhập mã xác nhận dưới đây ngay tại màn hình đăng nhập. Những lần đăng nhập sau sẽ không cần nhập mã này nữa."
                        : "Để hoàn tất đăng ký và bắt đầu đặt phòng, vui lòng xác thực địa chỉ email của bạn."}
                </p>

                ${verificationBoxHtml}

                <p style="font-size: 13px; color: #64748B; margin-bottom: 0; margin-top: 20px;">
                    Nếu bạn không thực hiện đăng ký tài khoản tại VietPeace Stay, vui lòng bỏ qua email này. Tài khoản sẽ không thể đăng nhập nếu chưa xác nhận mã kích hoạt.
                </p>
            </div>

            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 16px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email tự động, vui lòng không trả lời thư này.
            </div>
        </div>
    `;

    return sendTransactionalHtmlMail({
        toEmail,
        subject,
        textContent,
        htmlContent,
        logContext: "email xác nhận khách hàng",
    });
}

/**
 * Gửi email cấp mật khẩu mới khi khách hàng chọn Quên mật khẩu
 */
async function sendCustomerNewPasswordEmail({
    toEmail,
    fullName,
    newPassword,
}) {
    const safeName = escapeMailHtml(fullName || "Quý khách");
    const safeEmail = escapeMailHtml(toEmail || "");
    const safePassword = escapeMailHtml(newPassword || "");
    const loginUrlObj = new URL("/login", getWebLoginBaseUrl());
    if (toEmail) loginUrlObj.searchParams.set("email", toEmail);
    const safeLoginUrl = escapeMailHtml(loginUrlObj.toString());

    const subject = "[VietPeace Stay] Mật khẩu đăng nhập mới cho tài khoản của bạn";

    const textContent = [
        `Xin chào ${fullName || "Quý khách"},`,
        "",
        "Chúng tôi đã tiếp nhận yêu cầu cấp lại mật khẩu từ tính năng Quên mật khẩu trên VietPeace Stay.",
        `Tên đăng nhập (Email): ${toEmail}`,
        `Mật khẩu mới của bạn: ${newPassword}`,
        "",
        `Đăng nhập ngay tại: ${loginUrlObj.toString()}`,
        "Vì lý do bảo mật, bạn nên đổi lại mật khẩu cá nhân sau khi đăng nhập thành công.",
    ].join("\n");

    const htmlContent = `
        <div style="font-family: Arial, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #292D32; max-width: 620px; margin: 0 auto; border: 1px solid #E5E7EB; border-radius: 10px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
            <div style="background: linear-gradient(135deg, #173B2B 0%, #233B53 100%); color: #ffffff; padding: 28px 24px; text-align: center; border-bottom: 3px solid #F5B82E;">
                <h1 style="margin: 0; font-size: 22px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">VIETPEACE STAY</h1>
                <p style="margin: 6px 0 0; font-size: 13.5px; color: #FEF3C7; opacity: 0.95; font-weight: 500;">CẤP MẬT KHẨU ĐĂNG NHẬP MỚI</p>
            </div>

            <div style="padding: 28px 24px;">
                <p style="margin-top: 0; font-size: 15px;">Xin chào <strong>${safeName}</strong>,</p>
                <p style="font-size: 14.5px; color: #374151;">
                    Hệ thống VietPeace Stay đã tạo mật khẩu mới theo yêu cầu <strong>Quên mật khẩu</strong> cho tài khoản của bạn.
                </p>

                <div style="background-color: #FFFDF7; border: 1.5px dashed #D97706; border-radius: 10px; padding: 20px; margin: 22px 0;">
                    <div style="margin-bottom: 12px; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 6px; padding: 10px 14px;">
                        <div style="font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px;">Tên đăng nhập (Email)</div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 15px; font-weight: 700; color: #0F172A; margin-top: 2px; word-break: break-all;">${safeEmail}</div>
                    </div>

                    <div style="margin-bottom: 18px; background-color: #FFFBEB; border: 1px solid #FCD34D; border-radius: 6px; padding: 12px 14px;">
                        <div style="font-size: 11px; font-weight: 700; color: #92400E; text-transform: uppercase; letter-spacing: 0.5px;">Mật khẩu mới</div>
                        <div style="font-family: Consolas, 'Courier New', monospace; font-size: 20px; font-weight: 800; color: #0F172A; letter-spacing: 1px; margin-top: 4px; user-select: all; -webkit-user-select: all;">${safePassword}</div>
                    </div>

                    <div style="text-align: center;">
                        <a href="${safeLoginUrl}" style="background-color: #F5B82E; color: #0F172A; text-decoration: none; font-weight: 800; font-size: 14.5px; padding: 11px 24px; border-radius: 8px; display: inline-block; border: 1px solid #D99B16;">
                            Đăng nhập ngay &rarr;
                        </a>
                    </div>
                </div>

                <div style="background-color: #F8FAFC; border-left: 4px solid #F5B82E; padding: 12px 14px; border-radius: 0 6px 6px 0; font-size: 13px; color: #475569;">
                    <strong>Lưu ý bảo mật:</strong> Vui lòng sử dụng mật khẩu mới này để đăng nhập và bạn có thể đổi lại mật khẩu theo ý muốn trong mục Hồ sơ tài khoản.
                </div>
            </div>

            <div style="background-color: #F8FAFC; border-top: 1px solid #E2E8F0; padding: 16px 20px; text-align: center; font-size: 12px; color: #64748B;">
                © VietPeace Stay Hospitality. Email tự động, vui lòng không trả lời thư này.
            </div>
        </div>
    `;

    return sendTransactionalHtmlMail({
        toEmail,
        subject,
        textContent,
        htmlContent,
        logContext: "email cấp mật khẩu mới",
    });
}

module.exports = {
    sendAccountProvisionEmail,
    sendPasswordResetEmail,
    sendManagerFinancialWarningEmail,
    sendManagerBonusAndTetRewardEmail,
    sendChatCskhWarningEmail,
    sendCustomerVerificationEmail,
    sendCustomerNewPasswordEmail,
};
