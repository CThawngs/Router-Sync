# Vấn đề đã biết (Known Issues)

Dưới đây là các vấn đề đã biết trong phiên bản hiện tại của RouterSync, được theo dõi để người dùng và nhà phát triển có thể nắm rõ giới hạn của sản phẩm.

## 1. OmniRoute: `readRouterModelState` trả `availableModels=0`

Hàm `readRouterModelState` từ gói `@routersync/core` trả về `availableModels` rỗng cho router OmniRoute. Do đó, các mục OmniRoute trong lệnh `routersync apps drift` được phân loại là `MISSING`, mặc dù lệnh `routersync doctor` đếm được 281 model đang bật từ `combos.data.models`.

Nguyên nhân: `readRouterModelState` chưa đọc được danh sách model đang bật từ `combos.data.models` của OmniRoute.

## 2. Tên combo (`9Router-Coder-1`, `OmniRoute-Coder-1`) không có trong tập nào được đọc

Trường `comboModels` trong trạng thái router chứa các model ID nằm *trong* combo, chứ không phải tên combo. Do đó, khi ứng dụng tham chiếu tên combo (ví dụ `9Router-Coder-1`), lệnh drift không tìm thấy trong bất kỳ tập nào (`availableModels`, `comboModels`, `customModels`) và phân loại là `MISSING`.

## 3. Test đột biến H2.4 sống sót nhưng báo cáo ghi "ĐỎ"

Test đột biến sửa dòng `totals[entry.status]++` thành `totals[entry.status] = (totals[entry.status] || 0)` (bỏ `+ 1`) vẫn chạy xanh (exit 0), nhưng báo cáo ghi "ĐỎ". Nguyên nhân: test hiện tại không kiểm tra trực tiếp giá trị của `totals`, mà chỉ kiểm tra các điều kiện khác. Cần bổ sung test kiểm tra tổng các trạng thái bằng tổng số model app liệt kê.

## 4. Tên cổng riêng `xkiro`, `tokenharbor` vẫn nằm trong cột tên của `drift-run.txt`

Mặc dù báo cáo ghi số khớp bằng 0 cho tên cổng riêng, các tên `xkiro` và `tokenharbor` vẫn xuất hiện trong cột tên của tệp `drift-run.txt` do định dạng hiển thị kết hợp tên provider và tên model (`cổng/...`).
