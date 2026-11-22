# Tạo combo `rs-fast` và `rs-max` trong 9Router

Hai danh sách này được lập **chỉ từ bước đã đo** (hai lượt C32). Không bước nào
được thêm vì "nghe là ngon". `rs-fast` ưu tiên tốc độ; `rs-max` dùng nhiều provider
và account nhất mà không đưa bước treo (`HANG`) hoặc bước chết (`DEAD`) vào.

## 1. Tạo combo trong dashboard 9Router

1. Vào dashboard 9Router → **Combos** → **New combo**.
2. Tên: `rs-fast` hoặc `rs-max`. Chọn chiến lược **Fallback** (`fallback`).
3. Dán danh sách bước từ `combo-rs.real.txt` (bản trên chat), **mỗi dòng một bước**,
   giữ nguyên thứ tự.
4. Lưu. Không cần restart router.

## 2. Kiểm nhanh (chỉ gọi combo)

```
node packages/cli/dist/index.js combos probe --mode combo \
  --combo rs-fast --yes-spend-tokens --repeat 5 --combo-timeout-sec 120
```

Làm tương tự với `rs-max`. Kết quả mong đợi: `OK` và header dưới vài giây. Nếu vẫn
`HANG`, xem `x-9r-models-cache` (phải `hit` đa số) và bước phục vụ trong `usageHistory`.

## 3. Dùng trong agent

Trỏ model của agent vào `rs-fast` (hoặc `rs-max`). Đây vẫn là combo 9Router, nên
giữ nguyên khả năng failover giữa các account/provider.

## 4. Xóa combo thử

Nếu không dùng, xóa combo trong dashboard. RouterSync không xóa giúp: mọi thao tác
ghi vào router cần chủ dự án tự làm.

## Sắp xếp lại combo có sẵn (C40 X1)

Không cần xóa bước để sửa thứ tự. Lệnh sau **chỉ đọc DB** và ghi một tệp kế
hoạch + một tệp thứ tự mới:

```
routersync combos plan \
  --from evidence/C38/w4-reliability.out.txt \
  --from evidence/C32/c32-probe-step.out.txt \
  --out combo-plan.json \
  --emit-reorder reorder.real.txt
```

Thứ tự mới xếp theo hạng:

| hạng | nội dung |
|---|---|
| 1 | `RELIABLE`, sort theo p90 tăng dần — đây là các bước trả lời trước |
| 2 | `SLOW` |
| 3 | `RATE-LIMITED` (quota) — thất bại nhanh, giữ lại để dùng khi quota hồi |
| 4 | chưa đo |
| 5 | lỗi nhanh cứng (404/405/400/410) |
| 6 | `HANG` và 503 chậm (≥2 s) — **đặt cuối cùng, không xoá** |

Trong cùng hạng, thứ tự gốc được giữ khi chưa có số đo, và provider được xen kẽ
để một provider nghẽn không chặn cả hạng. Tệp `--emit-reorder` chứa **tên thật**,
chỉ dùng local; bản đã che tên riêng nằm trong gói bằng chứng.

Với `9Router-Agent-1` (combo OpenMausBot đang dùng), tệp in thêm vị trí cũ → mới
của từng bước `HANG`. Lệnh **không in `predictedHeaderMs` như một con số đáng tin**
— mô hình cũ có sai số trung vị 33,7%, tối đa 80,8% (C33). Chỉ nên đọc danh sách
"các bước đứng trước bước chạy được đầu tiên" và đối chiếu với số đo thật gần
nhất.

Sau khi có thứ tự mới: mở dashboard 9Router, sửa thứ tự bước của combo rồi lưu.
RouterSync không tự sửa combo.

## Thứ tự do chủ dự án quyết định (C41 Y1)

`--order speed` (mặc định) xếp theo p90 — nhanh nhất trước. Với bot agent, model
nhỏ đứng đầu thường cho chất lượng thấp; bạn có thể tự chọn thứ tự:

1. Chép `docs/examples/combo-order.example.txt` sang `.agent/combo-order.txt`
   (**tệp thật không lên GitHub**), thay mỗi dòng bằng một id bước đầy đủ.
2. Chạy:
   ```
   routersync combos plan \
     --from <các tệp probe/reliability> \
     --out combo-plan.json \
     --emit-reorder reorder.real.txt \
     --order file --order-file .agent/combo-order.txt
   ```
3. Các bước có trong tệp và còn đủ điều kiện đứng đầu theo **đúng thứ tự trong
   tệp**; các bước còn lại giữ xếp hạng C40. Bước trong tệp nhưng đang `HANG` hoặc
   `DEAD` bị chặn và in lý do — nó không được âm thầm đưa lên đầu. Dòng không khớp
   bước nào cũng được báo riêng.

Thứ tự đề xuất trong C41 chỉ suy ra từ **tên model** (lớn trước nhỏ trong cùng
provider, xen kẽ provider) — không phải số đo chất lượng. Hãy chỉnh bằng tệp riêng
của bạn.

## Giữ xoay vòng tài khoản, dùng fallback ở cấp combo

- Giữ nguyên cấu hình provider/account (nhiều tài khoản mỗi provider) — đây là nơi xoay vòng khi hết quota.
- Với `rs-fast` / `rs-max`, chọn **Fallback**; không copy chiến lược `round-robin` của `9Router-Agent` (combo treo lặp lại trong W1).
- Nếu muốn thử `round-robin`, đổi trong dashboard rồi đo lại bằng `routersync combos probe --mode combo --combo <tên> --yes-spend-tokens`.

## Lưu ý

- `rs-max` có nhiều bước hơn nhưng vẫn nằm trong một combo — router thử theo thứ tự.
- Các bước `HANG`/`DEAD` nằm ở danh sách "nên loại" trong `evidence/c37/REPORT.md`;
  không tự đưa lại vào combo.
- Nếu muốn thêm bước mới, chạy `routersync combos reliability` rồi lập lại danh sách.