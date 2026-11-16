/**
 * packages/cli/src/commands/display-strings.ts
 * Chuỗi hiển thị duy nhất cho autopilot-plan, discover, health (tiếng Việt có dấu).
 */
export const STR = {
  totalChanges: 'Tổng thay đổi',
  stepsExhausted: 'bước hết hạn',
  reason: 'Lý do',
  evidence: 'Bằng chứng',
  risk: 'Rủi ro',
  newModel: 'Model mới',
  candidate: 'ứng viên',
  provider: 'Nhà cung cấp',
  position: 'Vị trí',
  positionReasonDrop: 'bước hết hạn (vắng cả 2 vòng quét)',
  inCombo: 'trong combo',
  notInCombo: 'chưa có trong combo',
  notYetConfirmed: 'chưa xác nhận',
  positionSuggestion: 'Gợi ý vị trí',
  confirmedFreeByPrice: 'FREE-BY-PRICE đã xác nhận',
  groupByPrice: 'Nhóm theo giá',
  priceAllZero: 'Giá bằng 0 toàn nhà cung cấp',
  comboHead: 'Đầu combo hiện tại (để quyết định ghim)',
  headDiffEmpty: 'HEAD-DIFF trống ở vị trí 1–7',
  dropHold: 'DROP-HOLD (không đề xuất gỡ)',
  confirmAbsentDone: 'đã xác nhận vắng',
  scanCompleteness: 'Độ đầy đủ quét',
} as const;
