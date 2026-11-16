/**
 * packages/core/src/profile/questions.ts
 *
 * The twelve profile interview questions, owned by @routersync/core so the CLI
 * and the read-only MCP server read one list instead of two copies.
 */

export interface InterviewQuestion {
  id: string;
  prompt: string;
  default: string;
  hint: string;
}

export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  { id: 'purpose', prompt: 'Mục đích chính của combo là gì (ví dụ: lập trình, suy luận, chat)?', default: 'general coding', hint: 'Nhập chuỗi ngắn mô tả mục đích.' },
  { id: 'priority', prompt: 'Thứ tự ưu tiên, phân tách bằng dấu phẩy (quality, speed, price, context)?', default: 'quality, speed, price, context', hint: 'Chỉ dùng 4 giá trị: quality | speed | price | context.' },
  { id: 'freeOnly', prompt: 'Chỉ dùng model miễn phí (Y/n)?', default: 'Y', hint: 'Y = true, n = false.' },
  { id: 'preferredProviders', prompt: 'Các provider ưu tiên, ngăn bằng dấu phẩy?', default: '', hint: 'Để trống nếu không ưu tiên provider nào.' },
  { id: 'dislikedProviders', prompt: 'Các provider không muốn dùng, ngăn bằng dấu phẩy?', default: '', hint: 'Để trống nếu không loại trừ provider nào.' },
  { id: 'keepHead', prompt: 'Giữ nguyên N model đầu tiên không di chuyển?', default: '0', hint: 'Số nguyên >= 0.' },
  { id: 'allowList', prompt: 'Danh sách cho phép (allowList), ngăn bằng dấu phẩy?', default: '', hint: 'Để trống = không giới hạn.' },
  { id: 'denyList', prompt: 'Danh sách cấm (denyList), ngăn bằng dấu phẩy?', default: '', hint: 'Để trống = không cấm model nào.' },
  { id: 'automationLevel', prompt: 'Mức tự động hóa (observe, propose, auto-safe)?', default: 'observe', hint: 'Chỉ 3 giá trị: observe | propose | auto-safe.' },
  { id: 'limits', prompt: 'Giới hạn 3 số (gỡ%/combo, thêm/combo+thêm/ngày, di chuyển%)?', default: '10, 5+20, 25', hint: 'Ví dụ: 10, 5+20, 25 — gỡ ≤10% mỗi combo, thêm ≤5 mỗi combo và ≤20 mỗi ngày, di chuyển ≤25%.' },
  { id: 'scanCycle', prompt: 'Chu kỳ quét (hourly, daily, weekly, manual)?', default: 'daily', hint: 'Chỉ 4 giá trị: hourly | daily | weekly | manual.' },
  { id: 'timezone', prompt: 'Múi giờ của bạn?', default: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Ho_Chi_Minh', hint: 'Định dạng IANA, ví dụ Asia/Ho_Chi_Minh.' },
];
