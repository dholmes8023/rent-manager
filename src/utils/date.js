import dayjs from 'dayjs';

const YYYYMM_RE = /^[0-9]{6}$/;

export function isValidYyyymm(value) {
  return typeof value === 'string' && YYYYMM_RE.test(value);
}

export function currentYyyymm() {
  return dayjs().format('YYYYMM');
}

export function prevMonthStr(yyyymm) {
  if (!isValidYyyymm(yyyymm)) {
    throw new Error(`Invalid yyyymm: ${yyyymm}`);
  }
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  return dayjs(`${y}-${m}-01`).subtract(1, 'month').format('YYYYMM');
}

export function todayIso() {
  return dayjs().format('YYYY-MM-DD');
}
