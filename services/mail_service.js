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

module.exports = {
    sendAccountProvisionEmail,
    sendPasswordResetEmail,
};
