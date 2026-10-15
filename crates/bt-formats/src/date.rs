//! Parsing of the date strings SillyTavern has written over the years (`send_date`, `create_date`).

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn epoch_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> Option<i64> {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    Some(((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000 + ms)
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

fn digits(s: &str) -> Option<i64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// ISO 8601: `2024-05-30T14:22:05.333Z`, `2024-05-30 14:22:05`, `2024-05-30T14:22:05+02:00`.
fn parse_iso(s: &str) -> Option<i64> {
    let (date, time) = s.split_once(['T', ' ']).unwrap_or((s, "00:00:00"));
    let mut dp = date.split('-');
    let (y, mo, d) = (
        digits(dp.next()?)?,
        digits(dp.next()?)?,
        digits(dp.next()?)?,
    );
    if dp.next().is_some() {
        return None;
    }
    let (time, offset_ms) = if let Some(t) = time.strip_suffix('Z') {
        (t, 0)
    } else if let Some(idx) = time.rfind(['+', '-']).filter(|&i| i >= 5) {
        let (t, off) = time.split_at(idx);
        let sign = if off.starts_with('-') { -1 } else { 1 };
        let off = off[1..].replace(':', "");
        let (oh, om) = (
            digits(off.get(0..2)?)?,
            digits(off.get(2..4).unwrap_or("00"))?,
        );
        (t, sign * (oh * 60 + om) * 60_000)
    } else {
        (time, 0)
    };
    let mut tp = time.split(':');
    let h = digits(tp.next()?)?;
    let mi = digits(tp.next().unwrap_or("0"))?;
    let sec = tp.next().unwrap_or("0");
    let (sec, frac) = sec.split_once('.').unwrap_or((sec, ""));
    let ms = if frac.is_empty() {
        0
    } else {
        digits(&format!("{frac:0<3}")[..3])?
    };
    Some(epoch_ms(y, mo, d, h, mi, digits(sec)?, ms)? - offset_ms)
}

/// SillyTavern's humanized form: `October 14, 2026 11:56pm` (also `11:56 PM`, abbreviated months).
fn parse_humanized(s: &str) -> Option<i64> {
    let s = s.replace(',', " ");
    let mut it = s.split_whitespace();
    let month = it.next()?.to_ascii_lowercase();
    let mo = MONTHS.iter().position(|m| month.starts_with(m))? as i64 + 1;
    let d = digits(it.next()?)?;
    let y = digits(it.next()?)?;
    let mut time = it.collect::<Vec<_>>().join("").to_ascii_lowercase();
    let pm = time.ends_with("pm");
    let am = time.ends_with("am");
    if pm || am {
        time.truncate(time.len() - 2);
    }
    let (h, mi) = match time.split_once(':') {
        Some((h, m)) => (digits(h)?, digits(m)?),
        None if time.is_empty() => (0, 0),
        None => return None,
    };
    let h = match (pm, am, h) {
        (true, _, 12) => 12,
        (true, _, h) => h + 12,
        (_, true, 12) => 0,
        (_, _, h) => h,
    };
    epoch_ms(y, mo, d, h, mi, 0, 0)
}

/// Best-effort conversion of a SillyTavern date string to unix milliseconds (UTC assumed when no
/// offset is present).
pub fn parse_st_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Some(n) = digits(s) {
        return Some(if n < 100_000_000_000 { n * 1000 } else { n });
    }
    parse_iso(s).or_else(|| parse_humanized(s))
}

/// Formats unix milliseconds as ISO 8601 UTC (`2026-10-14T23:56:12.000Z`), the format current
/// SillyTavern versions write.
pub fn to_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = civil_from_days(days);
    let (h, rem) = (rem / 3_600_000, rem % 3_600_000);
    let (mi, rem) = (rem / 60_000, rem % 60_000);
    format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{:02}.{:03}Z",
        rem / 1000,
        rem % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_formats() {
        let iso = parse_st_date("2026-10-14T23:56:12.345Z").unwrap();
        assert_eq!(to_iso(iso), "2026-10-14T23:56:12.345Z");
        assert_eq!(parse_st_date("2026-10-15T01:56:12.345+02:00"), Some(iso));
        assert_eq!(
            parse_st_date("October 14, 2026 11:56pm"),
            parse_st_date("2026-10-14T23:56:00Z")
        );
        assert_eq!(
            parse_st_date("Oct 14, 2026 12:05 AM"),
            parse_st_date("2026-10-14T00:05:00Z")
        );
        assert_eq!(parse_st_date("1700000000"), Some(1_700_000_000_000));
        assert_eq!(parse_st_date("1700000000000"), Some(1_700_000_000_000));
        assert_eq!(parse_st_date("garbage"), None);
        assert_eq!(to_iso(0), "1970-01-01T00:00:00.000Z");
    }
}
