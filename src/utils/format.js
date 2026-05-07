const VND = new Intl.NumberFormat('vi-VN');

export function formatCurrency(value) {
  return `${VND.format(Number(value) || 0)} đ`;
}

export function formatNumber(value) {
  return VND.format(Number(value) || 0);
}
