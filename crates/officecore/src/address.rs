//! A1-style cell addressing shared by Calc import/export and PDF slicing.

/// Parses "B12" into zero-based (row, column).
pub fn parse(address: &str) -> Option<(u32, u32)> {
    let address = address.trim().trim_start_matches('$');
    let mut column = 0u32;
    let mut row = 0u32;
    let mut seen_column = false;
    let mut seen_row = false;
    for ch in address.chars() {
        if ch.is_ascii_alphabetic() {
            if seen_row {
                return None;
            }
            seen_column = true;
            column = column.checked_mul(26)?.checked_add((ch.to_ascii_uppercase() as u32) - ('A' as u32) + 1)?;
        } else if ch.is_ascii_digit() {
            seen_row = true;
            row = row.checked_mul(10)?.checked_add((ch as u32) - ('0' as u32))?;
        } else if ch == '$' {
            continue;
        } else {
            return None;
        }
    }
    if !seen_column || !seen_row || row == 0 || column == 0 {
        return None;
    }
    Some((row - 1, column - 1))
}

/// Formats zero-based (row, column) as "B12".
pub fn format(row: u32, column: u32) -> String {
    let mut name = String::new();
    let mut value = column + 1;
    while value > 0 {
        let remainder = ((value - 1) % 26) as u8;
        name.insert(0, (b'A' + remainder) as char);
        value = (value - 1) / 26;
    }
    name.push_str(&(row + 1).to_string());
    name
}

/// Column name for a zero-based index ("A", "AA", ...).
pub fn column_name(column: u32) -> String {
    let mut name = String::new();
    let mut value = column + 1;
    while value > 0 {
        let remainder = ((value - 1) % 26) as u8;
        name.insert(0, (b'A' + remainder) as char);
        value = (value - 1) / 26;
    }
    name
}

/// Parses "A1:B5" into zero-based corners. A single cell yields equal corners.
pub fn parse_range(range: &str) -> Option<((u32, u32), (u32, u32))> {
    let cleaned = range.replace('$', "");
    let mut parts = cleaned.split(':');
    let start = parse(parts.next()?)?;
    let end = match parts.next() {
        Some(value) => parse(value)?,
        None => start,
    };
    Some((start, end))
}

/// Expands "A1:B2" into all addresses, capped for safety.
pub fn expand_range(range: &str, limit: usize) -> Vec<String> {
    let Some(((row_a, col_a), (row_b, col_b))) = parse_range(range) else {
        return Vec::new();
    };
    let (top, bottom) = (row_a.min(row_b), row_a.max(row_b));
    let (left, right) = (col_a.min(col_b), col_a.max(col_b));
    let mut out = Vec::new();
    for row in top..=bottom {
        for column in left..=right {
            if out.len() >= limit {
                return out;
            }
            out.push(format(row, column));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_format() {
        assert_eq!(parse("A1"), Some((0, 0)));
        assert_eq!(parse("b12"), Some((11, 1)));
        assert_eq!(parse("AA10"), Some((9, 26)));
        assert_eq!(format(11, 1), "B12");
        assert_eq!(format(9, 26), "AA10");
        assert_eq!(column_name(27), "AB");
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("12"), None);
        assert_eq!(parse("A"), None);
        assert_eq!(parse("A1B"), None);
    }

    #[test]
    fn expands_ranges() {
        assert_eq!(expand_range("A1:B2", 100), vec!["A1", "B1", "A2", "B2"]);
        assert_eq!(expand_range("A1:A3", 2).len(), 2);
    }
}
