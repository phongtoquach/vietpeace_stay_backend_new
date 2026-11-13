# Giá & phòng trống — hướng dẫn triển khai và kiểm tra

## Phạm vi

### Hoàn thiện giao diện manager (08/11/2026)

Tái sử dụng `/pricing/bootstrap`, `/calendar`, `/preview`, `/apply` và `/proposals` hiện có. Không đổi backend duyệt, schema, migration hoặc bổ sung dữ liệu database trong đợt này; dữ liệu giá, phòng, cơ sở và booking hiện có được giữ nguyên.

Theo điều chỉnh giao diện mới, bỏ khung “Đề xuất giá tại cơ sở đang quản lý” khỏi Lịch giá & phòng trống và Thiết lập giá. Tab Kỳ giá đặc biệt của manager chỉ còn danh sách, tìm kiếm và lọc thời gian; không có cột thao tác, nút đề xuất áp dụng hoặc đường dẫn sang cấu hình kỳ. Giao diện đề xuất của manager cũng không còn các lựa chọn áp dụng/gỡ kỳ. Backend duyệt các đề xuất kỳ đã có vẫn được giữ nguyên.

Thiết lập giá có bố cục riêng cho manager: chọn Điều chỉnh theo ngày hoặc Thiết lập giá tuần, đánh dấu một/nhiều loại phòng ngay trong bảng giá rồi mở form đề xuất. Mặc định chưa chọn phòng. Nếu bấm đề xuất khi chưa chọn, hiển thị lỗi ngay cạnh hướng dẫn và chuyển focus/cuộn đến vùng chọn phòng; không khóa nút âm thầm. Chọn ít nhất một phòng rồi bấm lại sẽ mở form tương ứng. Giới hạn 50 loại phòng, không tự cắt danh sách. Payload gửi chính xác `roomIds` đã chọn, không bật `allRooms`; đổi cơ sở đặt lại lựa chọn phòng. Bảng ghi rõ tuần đang xem, đánh dấu hôm nay, số phòng và trạng thái kinh doanh. Các kỳ đã cấu hình tại cơ sở nằm trong phần thu gọn chỉ để xem.

Lý do bắt buộc, kiểm tra cả chuỗi chỉ có khoảng trắng. Form giá tuần của manager có hộp xổ xuống chọn từng loại phòng trong danh sách đã đánh dấu, bảng “Giá cũ” theo ngày hiệu lực và 7 ô “Giá mới đề xuất” ngay phía dưới. Bỏ dòng liệt kê “Đề xuất cho…” và cách nhập chung một bộ giá cho nhiều phòng. Mỗi lần xem trước/gửi chỉ dùng `roomIds: [phòng đang chọn]`, tái sử dụng API đề xuất hiện có. Đổi phòng tải lại giá mới từ giá tuần của phòng đó, bỏ các giá đang nhập của phòng trước và hủy bản xem trước cũ. Đổi ngày hiệu lực cập nhật giá cũ và những ô giá mới chưa chỉnh; giữ các ô đã nhập cho cùng phòng. Chỉnh giá/lý do cũng hủy bản xem trước để bắt buộc kiểm tra lại. Bản xem trước hiển thị trước/sau cho 7 ngày đầu; lịch tuần tiếp tục áp dụng đến khi có lịch thay thế. Thao tác từ một ô lịch tiếp tục chỉ gửi phòng tại ô đó. Giá giữ nguyên khi chờ duyệt hoặc bị từ chối, chỉ admin duyệt mới áp dụng giá và ghi lịch sử. Form giá tuần của admin giữ nguyên hành vi.

Trang đề xuất khóa cơ sở theo phân công và đưa `accId` ngoài phạm vi về cơ sở hợp lệ trước khi tải danh sách. Chi tiết có ngày hiệu lực, bộ giá tuần, bản xem trước lúc gửi, người duyệt/lý do từ chối và đường dẫn lịch sử sau khi duyệt. Đề xuất chờ/từ chối giữ nguyên giá. Trang loại phòng khóa giá gốc, phụ thu và giá tuần cho manager, bỏ các trường giá khỏi payload cập nhật thông tin phòng và giải thích việc tạo phòng mới cần admin thiết lập giá ban đầu. Các thao tác của admin tiếp tục dùng luồng hiện có.

Kiểm tra giao diện bằng `node --test --test-concurrency=1 test/pricing_configuration.test.js test/pricing_manager.test.js test/form_validation.test.js` trong thư mục admin, cùng lint các file đã sửa và production build. Kiểm thử render không thay thế kiểm tra thao tác trực tiếp trên trình duyệt với tài khoản manager/admin thật. Lần kiểm tra trực tiếp mới nhất bị chặn vì các cửa sổ Chrome thu nhỏ và công cụ không khôi phục được cửa sổ.

### Rà soát admin: phạm vi, giá tuần và điều hướng

Điều chỉnh từ một ô lịch gửi đúng `roomIds`, không bật `allRooms`; cập nhật hàng loạt tiếp tục áp dụng toàn bộ loại phòng của các cơ sở được chọn. Form hiển thị rõ tên loại phòng khi thao tác một phòng. Giá khởi tạo cho sửa tuần được tính từ lịch có hiệu lực tại ngày bắt đầu đã chọn, không sao chép các giá quá khứ trong bảng tuần hiện tại. Đổi ngày hiệu lực cập nhật các ô chưa chỉnh sửa; giữ các giá admin đã nhập.

Bản xem trước áp dụng kỳ trả thêm `periodOverlaps`: kỳ đang thắng trước thay đổi, cơ sở/phòng và các khoảng ngày trùng (gồm cả ngày cuối). UI hiển thị kỳ mới sẽ được ưu tiên hơn kỳ nào trước nút xác nhận; các ngày giữ override vẫn theo lựa chọn giữ/thay thế đã xác nhận. Xem trước không lưu giá và mã xác nhận vẫn gắn với trạng thái dữ liệu hiện tại.

Lịch sử đọc cả `weekdayRates` từ thao tác tại trang loại phòng, gồm từng thứ trước/sau và các giá được gỡ; payload cập nhật không có trường này không tạo chi tiết giả. Các trang giá giữ `accId` khi điều hướng, riêng tab và menu Lịch sử thay đổi mở mặc định Tất cả cơ sở. Liên kết xem lịch sử một cơ sở cụ thể vẫn hỗ trợ `accId`. Admin sửa giá tuần bằng nút Sửa tuần tại từng loại phòng; đã bỏ nút thiết lập chung màu cam. Form hiển thị tên phòng, bảng Giá cũ theo ngày hiệu lực và phần Giá mới ngay bên dưới để đối chiếu. Không thêm schema, migration hoặc dữ liệu mẫu cho đợt sửa này.

### Cập nhật hàng loạt và kỳ giá theo danh mục

#### Cảnh báo giá trùng trước khi xem trước

Đã bỏ các checkbox giữ/thay thế điều chỉnh cũ khỏi form. Với thao tác điều chỉnh theo ngày hoặc áp dụng kỳ, client gửi `conflictHandling: 'ask'` khi bấm Xem trước. Backend kiểm tra override trong đúng cơ sở/phòng/ngày được chọn, trước khi mô phỏng thay đổi. Không trùng thì trả bản xem trước bình thường. Có trùng thì trả `needsConflictResolution`, số cơ sở/phòng/ngày/ô bị trùng, các khoảng ngày liên tiếp cùng giá và mã kiểm tra có hạn 5 phút; không ghi giá, lịch sử hay đề xuất tại bước cảnh báo.

Popup có Quay lại chỉnh sửa, Giữ giá đã điều chỉnh (`keep`) và Thay bằng giá mới (`replace`). Một lựa chọn áp dụng chung cho tất cả các mục bị trùng. Sau khi chọn, backend kiểm tra mã gắn với tài khoản, payload và dữ liệu hiện tại, rồi mới trả bản xem trước cuối cùng. Nếu dữ liệu hoặc phạm vi thay đổi trước lúc chọn, trả cảnh báo mới để người dùng xem lại. Nút xác nhận cuối cùng tiếp tục kiểm tra phiên bản; không có thao tác tự lưu từ popup.

`keep` giữ override tại ngày trùng; các ngày còn lại vẫn nhận giá mới. `replace` tính lại từ giá tuần/kỳ hiện hành với điều chỉnh theo ngày, hoặc gỡ override trong khoảng kỳ khi áp dụng kỳ đặc biệt; không cộng chồng giá cũ. Manager lưu lựa chọn vào đề xuất và chờ duyệt; không lưu mã kiểm tra tạm thời vào đề xuất. Các payload cũ vẫn được đọc để giữ tương thích với đề xuất/lịch sử đã có. Không thêm schema, migration hay dữ liệu mẫu.

Menu thao tác gom bốn cách tăng/giảm vào mục “Điều chỉnh giá theo ngày”. Chọn mục này sẽ hiện “Cách điều chỉnh” (tăng %, giảm %, tăng số tiền, giảm số tiền), giá trị với đơn vị tương ứng và khoảng ngày. Mục gỡ mang tên “Gỡ điều chỉnh theo ngày”. Các nhãn nguồn giá trên lịch, chi tiết và lịch sử cũng dùng tên mới; tên bảng/cột kỹ thuật giữ nguyên để không ảnh hưởng dữ liệu đang có.


Menu cập nhật hàng loạt gồm điều chỉnh giá theo ngày, tên kỳ giá đặc biệt, gỡ kỳ giá đặc biệt và gỡ điều chỉnh theo ngày. Backend tự lấy toàn bộ loại phòng hiện có trong cơ sở được chọn và luôn áp dụng tất cả ngày trong khoảng. Không nhận chọn phòng/thứ từ giao diện này. Manager vẫn gửi đề xuất, admin áp dụng trực tiếp. Giá trị dùng input văn bản số, đơn vị nằm bên phải.

`20261108_period_direction.sql` bổ sung `rate_periods.adjustment_direction` (`increase`/`decrease`). Kỳ mới bắt buộc chọn hướng; kỳ cũ thiếu hướng phải được admin cập nhật trước khi áp dụng. Khi chọn tên kỳ, ngày lấy từ danh mục và bị khóa cả UI lẫn API. Giá trị <=100 tính theo %, >100 tính theo VNĐ; backend suy ra hướng từ danh mục, không tin hướng do client gửi. Giảm 100% bị từ chối vì giá không được bằng 0. Ngày đã qua không bị ghi đè. Kỳ mới áp dụng có ưu tiên cao hơn các kỳ khác tại cơ sở; không cộng dồn kỳ. Nếu có trùng điều chỉnh theo ngày, popup yêu cầu chọn giữ giá đã điều chỉnh hoặc thay bằng giá kỳ mới.

“Gỡ kỳ giá đặc biệt” gỡ toàn bộ cấu hình kỳ được chỉ định hoặc tất cả kỳ còn hiệu lực tại phạm vi cơ sở. Khoảng xem trước bao phủ toàn bộ ngày tương lai bị ảnh hưởng; không phải chỉ gỡ một đoạn trong kỳ. Giữ `first_applied_at`, lịch sử và snapshot booking. “Gỡ điều chỉnh theo ngày” chỉ gỡ override trong khoảng ngày chọn, quay về giá kỳ/giá tuần hiện hành.

Đã bỏ form cập nhật cũ và endpoint tải danh sách phòng không còn dùng. `20261108_cleanup_sale_controls.sql` xóa bảng đóng/mở bán đã nghỉ dùng chỉ khi bảng rỗng, đồng thời cập nhật hàm tính giá/tồn. Nếu có dữ liệu, migration dừng để tránh mất dữ liệu. Giữ bảng giá tuần gốc và `room_weekday_rate_schedules` vì màn sửa giá tuần riêng vẫn sử dụng chúng; các mục này không còn nằm trong menu cập nhật hàng loạt. Giữ nhãn thao tác cũ để đọc lịch sử đã lưu.

### Đề xuất giá và phê duyệt (08/11/2026)

Tài khoản `ADMIN` hiện có là người duyệt; không tạo thêm tài khoản hay vai trò. Manager xem trước điều chỉnh tại Thiết lập giá rồi bấm “Gửi đề xuất”, bắt buộc có lý do và chỉ dùng phòng trong cơ sở đang quản lý. Tất cả thao tác gửi từ manager (giá điều chỉnh theo ngày, giá tuần và kỳ giá) được lưu `PENDING`; giá và phòng đang bán không thay đổi. Manager không được ghi giá trực tiếp qua trang loại phòng; giá ban đầu của phòng mới do admin thiết lập.

Migration `20261108_pricing_proposals.sql` bổ sung duy nhất bảng `pricing_proposals`: payload đề xuất, ảnh chụp thay đổi, dấu kiểm tra dữ liệu gốc, lý do, người gửi/duyệt, trạng thái `PENDING`/`APPROVED`/`REJECTED`, rowversion và mã lịch sử khi áp dụng. Không seed dữ liệu. Script migration đã bao gồm file này; có thể chạy riêng file mới để tránh chạy các migration dọn dẹp cũ.

Tab `/admin/pricing-proposals` nằm cạnh Lịch sử thay đổi. Admin kiểm tra đề xuất rồi xác nhận duyệt, hoặc từ chối kèm lý do. Việc áp dụng giá, ghi lịch sử với người duyệt và đổi trạng thái diễn ra cùng transaction. Duyệt lại, bản kiểm tra quá hạn, dữ liệu đã đổi, manager hết quyền/đổi phân công hoặc tài khoản ngừng hoạt động đều bị chặn. Đề xuất lỗi thời cần manager gửi lại. Đề xuất đang chờ hoặc từ chối không xuất hiện như một thay đổi giá đã áp dụng trong lịch sử.

Module dùng dữ liệu thật của `VietPeaceStayDB`, giữ mô hình một manager–một cơ sở hiện có. Không tạo dữ liệu kỳ lễ/giá mẫu. Các bảng giá tuần, booking và snapshot cũ được giữ nguyên.

Admin quản lý danh mục kỳ dùng chung, áp dụng/gỡ kỳ tại cơ sở và xem lịch giá toàn hệ thống. Manager cần `pricing.read` / `pricing.write` và bản ghi phân công còn hiệu lực, chỉ gửi đề xuất cho cơ sở được giao. Quyền được kiểm tra lại trong transaction và khi admin duyệt, kể cả các đường sửa giá từ trang loại phòng.

## Cài đặt

Trong thư mục backend:

```powershell
node scripts/migrate_pricing.js
npm run dev
```

Lệnh migration chạy lần lượt `20261107_pricing_inventory.sql`, `20261107_remove_inventory_blocks.sql`, `20261107_remove_price_limits.sql` và `20261107_remove_period_global_toggle.sql`, chạy lặp được. Các bản dọn dẹp xóa bảng/cột và dữ liệu lịch sử của những tính năng đã gỡ. Thành viên khác phải chạy trên database của họ trước khi chạy backend mới. Không tự chạy migration khi khởi động server.

Trong thư mục admin:

```powershell
npm run dev
```

Vite dùng cổng theo cấu hình hiện có (5175). Nếu backend cũ chưa tự reload, hãy khởi động lại để nhận route `/api/admin/pricing/*`. Không thay đổi cấu hình SMTP hoặc mật khẩu.

## Database

Sáu bảng nghiệp vụ:

| Bảng | Vai trò |
| --- | --- |
| `rate_periods` | Danh mục kỳ dùng chung, ngày bắt đầu/kết thúc, mô tả, xóa mềm, rowversion; không có bật/tắt toàn hệ thống |
| `accommodation_rate_periods` | Gắn kỳ vào cơ sở; bật/tắt và ưu tiên tại cơ sở |
| `room_period_rates` | Cách điều chỉnh và giá trị cho từng loại phòng |
| `room_daily_rate_overrides` | Giá cố định riêng theo loại phòng/ngày |
| `pricing_inventory_audit_logs` | Người sửa, lý do, trước/sau và mã thao tác hàng loạt |

Thêm bảng thứ bảy `room_weekday_rate_schedules` để lên lịch giá tuần có ngày hiệu lực. Bảy giá hiện có trong `room_weekday_rates` vẫn là giá ban đầu. Lịch mới thắng kể từ ngày hiệu lực; lịch có ngày bắt đầu muộn hơn thay thế lịch cũ. Mỗi lần lưu đủ 7 thứ.


Hàm inline SQL `dbo.fn_room_daily_offer` là nguồn tính giá và tồn dùng chung cho lịch admin, báo giá khách và tìm kiếm có ngày lưu trú. Không lưu bảng số phòng còn độc lập để nhập tay.

## Quy tắc

Danh sách kỳ có ba bộ phận trên cùng khung: tìm theo tên, lọc thời gian có số lượng, nút tạo. Phạm vi áp dụng đếm cơ sở chưa xóa có cấu hình đang bật và có quy tắc phòng; nếu bằng tổng số cơ sở thì hiện “Toàn bộ cơ sở”. Mô tả vẫn được lưu và sửa trong form nhưng không hiển thị dưới tên ở danh sách.

Migration `20261107_lock_applied_periods.sql` thêm `rate_periods.first_applied_at` (datetime2, nullable). Kỳ cũ đã có liên kết cấu hình cơ sở được đánh dấu đã từng áp dụng; kỳ mới được đánh dấu khi lưu cấu hình đang bật có quy tắc phòng. Xem trước rollback không đánh dấu. Kỳ đã từng áp dụng bị khóa sửa/xóa cả UI và API, kể cả sau khi tắt/gỡ cấu hình. Xóa kỳ chưa áp dụng dùng xóa mềm `deleted_at` để giữ lịch sử; không xóa giá hoặc booking. Luồng áp dụng sau này cần ghi nhận mốc này khi áp dụng thành công.

Tạo kỳ chỉ lưu tên, khoảng thời gian và mô tả vào danh mục, chuẩn bị cho bước admin chọn áp dụng được tổ chức sau. Không tự gắn kỳ vào cơ sở hoặc đổi giá khi tạo. Không còn cột `rate_periods.is_active`; nhãn thời gian trên danh sách không thể hiện trạng thái đã áp dụng. Các cấu hình cơ sở có sẵn vẫn được giữ; luồng cập nhật hàng loạt chưa được tổ chức lại trong bước này.

1. Giá tuần đã lên lịch có hiệu lực → giá tuần ban đầu → giá gốc nếu thiếu.
2. Áp dụng một kỳ đặc biệt: ưu tiên cao hơn thắng. Cùng ưu tiên và chồng ngày trên cùng loại phòng bị từ chối. Không cộng dồn kỳ.
3. Giá điều chỉnh theo ngày ngày cụ thể thay kết quả trên. Gỡ điều chỉnh theo ngày sẽ quay về quy tắc.
4. Phụ thu khách và thuế/phí tiếp tục do luồng quote hiện có xử lý. Module này chưa triển khai khuyến mãi.

Mọi khoảng ngày gồm ngày bắt đầu, không gồm ngày kết thúc. Thứ được tính độc lập thiết lập DATEFIRST của SQL Server. “Hôm nay” theo Asia/Ho_Chi_Minh.

Tồn thực tế = tổng phòng − booking CONFIRMED. PENDING tiếp tục không giữ phòng theo chính sách có sẵn; PAYMENT_PROCESSING cũng chưa có cơ chế giữ tồn riêng. Module thanh toán/xác nhận nguyên tử chưa được xây trong thay đổi này, do project hiện chỉ có route preview và lưu pending.

Giá đã chốt trong `booking_item_nightly_rates` không bị sửa khi thay bảng giá. Giá tìm kiếm khi có ngày là giá phòng trung bình/đêm trong kỳ, trước phụ thu/thuế; chỉ xét loại phòng còn bán xuyên suốt kỳ.

## Các màn hình

Admin dùng “Cập nhật hàng loạt” tại Thiết lập giá để chọn một/tất cả cơ sở hoặc đánh dấu nhiều cơ sở cụ thể. Hai cách chọn loại trừ nhau. Danh sách phòng lấy từ database hiện có, lọc theo phạm vi đang chọn; thao tác chỉ áp dụng cho phòng được đánh dấu. Xem trước hiển thị cơ sở, phòng và giá trước/sau (tối đa 80 ô hiển thị). Lưu nhiều cơ sở trong cùng một transaction và cùng mã lịch sử; lỗi ở bất kỳ cơ sở nào sẽ rollback toàn bộ. Đổi phạm vi, dữ liệu hoặc quyền sau xem trước yêu cầu xem trước lại. Không thêm schema hay seed. Phạm vi tối đa 120.000 ô phòng/ngày, 50 loại phòng mỗi cơ sở. Manager tiếp tục chỉ cập nhật cơ sở được giao.

- `/admin/room-availability`: lịch 7/14/30 ngày; giá, tồn, mở chi tiết ô, cập nhật hàng loạt.
- `/admin/room-rates`: giá tuần, lịch có hiệu lực, cấu hình kỳ tại cơ sở.
- `/admin/rate-periods`: tạo/sửa/lưu trữ kỳ dùng chung (admin); manager xem danh mục và đi tới cấu hình cơ sở.
- `/admin/pricing-history`: lịch sử theo cơ sở, tên người sửa, giờ Việt Nam, chi tiết trường trước/sau, tải thêm 50 thao tác/lần.

## Các bước kiểm tra thủ công

1. Đăng nhập admin, mở lịch; chọn cơ sở và một ngày tương lai. So sánh giá theo thứ với bảng giá cũ.
2. Click ô, xem nguồn giá và tồn. Đặt giá điều chỉnh theo ngày → nhập lý do → Xem trước → Xác nhận lưu. Tải lại trang, giá vẫn còn.
3. Gỡ điều chỉnh theo ngày, kiểm tra giá quay lại quy tắc.
4. Admin tạo kỳ đặc biệt. Đăng nhập manager của cơ sở để cấu hình tăng 20% cho một loại phòng. Kiểm tra nguồn giá hiện tên kỳ và giá tăng trên giá theo thứ. Admin chọn tên kỳ trong menu cập nhật hàng loạt để áp dụng trực tiếp; manager gửi đề xuất và chờ admin duyệt.
5. Admin tạo kỳ thứ hai; manager cấu hình trùng ngày/cùng ưu tiên/cùng loại phòng: phải báo xung đột. Manager tăng ưu tiên để kiểm tra kỳ thắng.
6. Thiết lập đủ 7 giá tuần từ ngày tương lai: ngày trước đó giữ nguyên; từ ngày hiệu lực dùng lịch mới.
7. Cập nhật hàng loạt theo một số thứ. Mặc định bỏ qua giá điều chỉnh theo ngày. Bỏ chọn tùy chọn này nếu muốn thay thế.
9. Thử giảm tổng số phòng xuống thấp hơn số đã đặt hoặc giảm giá xuống 0/âm: phải bị từ chối.
11. Hai tab cùng xem trước; tab thứ nhất lưu, tab thứ hai lưu bản cũ: phải yêu cầu xem trước lại.
12. Đăng nhập manager: chỉ có cơ sở được giao; không có quyền sửa danh mục kỳ dùng chung . Gỡ phân công/thu hồi quyền rồi thử lưu bản xem trước cũ: bị từ chối.
13. Kiểm tra lịch sử; so sánh báo giá trên web cùng loại phòng/ngày. Booking đã xác nhận trước đó giữ snapshot cũ.

## Kiểm thử tự động

```powershell
$env:RUN_DB_PRICING_TESTS = '1'
node --test test/pricing_inventory.test.js
```

Các ca tích hợp chạy trên SQL thật dưới outer transaction và rollback toàn bộ dữ liệu test. Identity có thể có khoảng trống do rollback; đây là hành vi SQL Server, không phải mất dữ liệu. Không gửi email. Mặc định không bật biến môi trường thì bỏ qua ca tích hợp.

Trong admin:

```powershell
node node_modules/eslint/bin/eslint.js src/pages/pricing src/api/pricing.js
node node_modules/vite/bin/vite.js build
```

## Giới hạn chủ động

- Mỗi thao tác hàng loạt thực hiện trong một cơ sở, tối đa 50 loại phòng và 366 đêm; kỳ dùng chung tối đa 731 đêm. Lịch xem tối đa 31 ngày/API.
- Bắt đầu cấu hình trong 2 năm tới; kỳ kết thúc tối đa 3 năm. Lịch tuần tiếp tục hiệu lực đến lịch mới.
- Bản xem trước hết hạn sau 5 phút, gắn với tài khoản, payload và trạng thái dữ liệu. Khởi động lại backend làm bản xem trước cũ hết hiệu lực; hiện phù hợp backend một tiến trình.
- Xem trước chạy trong transaction và rollback; lưu chạy lại kiểm tra. App lock và SERIALIZABLE bảo vệ các đường ghi giá mới. Chưa hỗ trợ phối hợp với một luồng xác nhận thanh toán bên ngoài module.
- Chưa có duyệt ngoại lệ, nhiều gói giá, khuyến mãi, OTA, phòng vật lý/housekeeping hoặc giá tự động theo nhu cầu.
- Kiểm tra trực quan bằng Chrome chưa hoàn tất: Computer Use dừng do không xác định URL đủ chắc chắn. Build, lint module và ca SQL/API là các kiểm tra đã thực hiện; người dùng cần thử UI theo danh sách trên.
