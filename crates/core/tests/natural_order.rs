//! The natural order of names. The tests check three properties.
//!
//! 1. It is a total order, also for names that are likely to collide: few
//!    letters, many digit runs, zeros, mixed case and invalid UTF-8. A slow
//!    model makes a key from one name only, so the model is a total order
//!    by its construction. The comparison must give the result of the model.
//!    Other tests check transitivity and antisymmetry without the model.
//! 2. The comparison does not allocate.
//! 3. The work count includes all bytes that the comparison reads, because
//!    the count decides when a build step stops.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::cmp::Ordering;
use std::time::Instant;

use zipscope_core::query::{
    BYTES_PER_UNIT, PREFIX_BYTES_PER_UNIT, compare_names, compare_names_counted,
};

struct Counting;

// Each test thread has its own count, so other tests do not change it.
thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: It only counts the calls and gives each call to `System`.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.set(ALLOCATIONS.get() + 1);
        // SAFETY: The caller obeys the contract of `alloc`.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: The caller obeys the contract of `dealloc`.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.set(ALLOCATIONS.get() + 1);
        // SAFETY: The caller obeys the contract of `realloc`.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// One part of a name in the model: the rank among bytes, then the length
/// and the digits of a number. Letters have the rank of their lower case. A
/// number has the rank of a digit. No other part has that rank.
type Part = (u8, usize, Vec<u8>);

/// The sort key of one name in the model. It uses only that name.
fn model_key(name: &[u8]) -> (Vec<Part>, Vec<u8>) {
    let mut parts = Vec::new();
    let mut at = 0;
    while at < name.len() {
        if name[at].is_ascii_digit() {
            let start = at;
            while at < name.len() && name[at].is_ascii_digit() {
                at += 1;
            }
            let run = &name[start..at];
            let zeros = run.iter().take_while(|&&byte| byte == b'0').count();
            parts.push((b'0', run.len() - zeros, run[zeros..].to_vec()));
        } else {
            parts.push((name[at].to_ascii_lowercase(), 0, Vec::new()));
            at += 1;
        }
    }
    (parts, name.to_vec())
}

fn next(seed: &mut u64) -> usize {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    usize::try_from(*seed >> 40).unwrap()
}

/// Returns a name that is likely to collide with other names of this type.
fn colliding_name(seed: &mut u64) -> Vec<u8> {
    const OTHER: [&[u8]; 9] = [
        b"a",
        b"A",
        b"b",
        b"B",
        b".",
        b"/",
        b"\xFF",
        b"\xC3\xA9",
        "\u{0663}".as_bytes(),
    ];
    let mut name = Vec::new();
    for _ in 0..next(seed) % 5 {
        match next(seed) % 5 {
            0 => name.extend(OTHER[next(seed) % OTHER.len()]),
            1 => name.extend(std::iter::repeat_n(b'0', next(seed) % 4)),
            2 => name.push(b'0' + u8::try_from(next(seed) % 3).unwrap()),
            3 => name.extend(&b"10"[..=next(seed) % 2]),
            _ => name.extend(b"a0"),
        }
    }
    name
}

fn assert_sorted(names: &[&[u8]]) {
    for (i, a) in names.iter().enumerate() {
        for (j, b) in names.iter().enumerate() {
            assert_eq!(
                compare_names(a, b),
                i.cmp(&j),
                "{:?} and {:?}",
                String::from_utf8_lossy(a),
                String::from_utf8_lossy(b),
            );
        }
    }
}

#[test]
fn numbers_compare_by_value() {
    assert_sorted(&[
        b"file01",
        b"file1",
        b"file2",
        b"File3",
        b"file3",
        b"file10",
        b"file010x",
    ]);
    assert_sorted(&[
        b"a", b"a0", b"a00", b"a000", b"a1", b"a9", b"a10", b"a99", b"a100",
    ]);
    // A run has more digits than any integer type.
    let large = "9".repeat(100);
    let larger = format!("1{}", "0".repeat(100));
    let zeros = format!("{}{larger}", "0".repeat(100));
    assert_sorted(&[large.as_bytes(), zeros.as_bytes(), larger.as_bytes()]);
}

#[test]
fn the_tie_of_zeros_does_not_hide_a_later_difference() {
    // The first key reads the full names. Then the bytes decide.
    assert_sorted(&[b"a01b02", b"a01b2", b"a1b02", b"a1b2", b"a01b3", b"a1b3"]);
    assert_sorted(&[b"A1", b"a01", b"a1", b"a01b", b"A1c"]);
    assert_sorted(&[b"a0", b"a00", b"a00b", b"a0b", b"a00c", b"a0c"]);
    assert_sorted(&[b"a0!", b"a00!"]);
}

#[test]
fn a_difference_inside_a_number_uses_the_full_number() {
    // A comparison from the first different byte gives a cycle here:
    // `a1b` after `a12`, `a12` after `a2`, and `a2` after `a1b`.
    assert_sorted(&[b"a1b", b"a2", b"a12"]);
    assert_sorted(&[b"a10", b"a20", b"a100"]);
    assert_sorted(&[b"v1.9", b"v1.10", b"v2.0"]);
}

#[test]
fn a_number_sorts_where_a_digit_sorts_among_other_bytes() {
    assert_sorted(&[
        b"a", b"a!", b"a/", b"a0", b"a7", b"a12", b"a:", b"a[", b"ab", b"a\xFF",
    ]);
    assert_sorted(&[b"", b"!", b"1", b"10", b"a"]);
}

#[test]
fn other_digits_keep_their_bytes() {
    // U+0663 is D9 A3 and U+0664 is D9 A4. U+FF11 is EF BC 91.
    let (three, four, one) = ("a\u{0663}", "a\u{0664}", "a\u{FF11}");
    let long = "a\u{0663}\u{0663}";
    assert_sorted(&[
        b"a2",
        b"a10",
        three.as_bytes(),
        long.as_bytes(),
        four.as_bytes(),
        one.as_bytes(),
    ]);
}

#[test]
fn only_byte_equal_names_are_equal() {
    assert_eq!(compare_names(b"a1", b"a1"), Ordering::Equal);
    assert_eq!(compare_names(b"", b""), Ordering::Equal);
    for (a, b) in [
        (&b"a01"[..], &b"a1"[..]),
        (b"a0", b"a00"),
        (b"A", b"a"),
        (b"a1B02", b"a01b2"),
        (b"\xFF0", b"\xFF00"),
    ] {
        let order = compare_names(a, b);
        assert_ne!(order, Ordering::Equal);
        assert_eq!(compare_names(b, a), order.reverse());
    }
}

#[test]
fn all_short_names_follow_the_model() {
    const ALPHABET: [u8; 6] = [b'0', b'1', b'a', b'A', b'.', 0xFF];
    let mut names: Vec<Vec<u8>> = vec![Vec::new()];
    let mut start = 0;
    for _ in 0..4 {
        let end = names.len();
        for at in start..end {
            for byte in ALPHABET {
                let mut name = names[at].clone();
                name.push(byte);
                names.push(name);
            }
        }
        start = end;
    }
    let keys: Vec<_> = names.iter().map(|name| model_key(name)).collect();
    for (a, a_key) in names.iter().zip(&keys) {
        for (b, b_key) in names.iter().zip(&keys) {
            assert_eq!(compare_names(a, b), a_key.cmp(b_key), "{a:?} and {b:?}");
        }
    }
}

#[test]
fn colliding_names_follow_the_model() {
    let mut seed = 0x1234_5678_9abc_def1;
    for _ in 0..300_000 {
        let (a, b) = (colliding_name(&mut seed), colliding_name(&mut seed));
        assert_eq!(
            compare_names(&a, &b),
            model_key(&a).cmp(&model_key(&b)),
            "{a:?} and {b:?}"
        );
    }
}

#[test]
fn colliding_names_are_antisymmetric_and_transitive() {
    let mut seed = 0x0fed_cba9_8765_4321;
    let pool: Vec<Vec<u8>> = (0..600).map(|_| colliding_name(&mut seed)).collect();
    for a in &pool {
        for b in &pool {
            let order = compare_names(a, b);
            assert_eq!(compare_names(b, a), order.reverse(), "{a:?} and {b:?}");
            assert_eq!(order == Ordering::Equal, a == b, "{a:?} and {b:?}");
        }
    }
    for _ in 0..1_000_000 {
        let a = &pool[next(&mut seed) % pool.len()];
        let b = &pool[next(&mut seed) % pool.len()];
        let c = &pool[next(&mut seed) % pool.len()];
        if compare_names(a, b).is_le() && compare_names(b, c).is_le() {
            assert!(compare_names(a, c).is_le(), "{a:?}, {b:?} and {c:?}");
        }
    }
    // The standard sort can panic when an order is not total. After the
    // sort, each pair must be in order, not only the adjacent items.
    let mut sorted = pool.clone();
    sorted.sort_by(|a, b| compare_names(a, b));
    for (i, a) in sorted.iter().enumerate() {
        for b in &sorted[i..] {
            assert!(compare_names(a, b).is_le(), "{a:?} and {b:?}");
        }
    }
}

/// Returns the units of a comparison, and checks that they do not change
/// with the direction.
fn units(a: &[u8], b: &[u8]) -> usize {
    let (order, units) = compare_names_counted(a, b);
    let (other, other_units) = compare_names_counted(b, a);
    assert_eq!(other, order.reverse());
    assert_eq!(other_units, units);
    units
}

fn repeated(byte: char, count: usize, end: &str) -> Vec<u8> {
    let mut name = String::from(byte).repeat(count);
    name.push_str(end);
    name.into_bytes()
}

const LENGTH: usize = 6400;

#[test]
fn the_work_count_includes_each_path_of_a_number() {
    let per_byte = |bytes: usize| 1 + bytes / BYTES_PER_UNIT;
    // A short number costs the same as a short name.
    assert_eq!(units(b"file2", b"file10"), 1);
    assert_eq!(units(b"file-0002.txt", b"file-0010.txt"), 1);
    // Leading zeros that one name skips, and no common prefix.
    let zeros = repeated('0', LENGTH, "1");
    assert_eq!(units(&zeros, b"1"), per_byte(LENGTH + 2));
    assert_eq!(compare_names(&zeros, b"1"), Ordering::Less);
    // Leading zeros in both names, read by the common prefix and then from
    // the end of the common prefix.
    let other = repeated('0', LENGTH, "2");
    assert_eq!(
        units(&zeros, &other),
        LENGTH / PREFIX_BYTES_PER_UNIT + per_byte(LENGTH + 2)
    );
    // Zeros after a common zero: a misaligned walk with a later number.
    let (mut left, mut right) = (repeated('0', LENGTH, "1a"), repeated('0', 10, "1a"));
    left.extend(repeated('0', LENGTH, "5"));
    right.extend(repeated('0', 10, "4"));
    assert_eq!(compare_names(&left, &right), Ordering::Greater);
    assert_eq!(
        units(&left, &right),
        per_byte(10 + (LENGTH - 10 + 2 + LENGTH + 1) + (2 + 10 + 1)),
    );
    // The number is decided at its first digit, but the length is still read.
    let large = {
        let mut name = b"1".to_vec();
        name.extend(repeated('7', LENGTH, ""));
        name
    };
    let larger = {
        let mut name = b"2".to_vec();
        name.extend(repeated('7', LENGTH, ""));
        name
    };
    assert_eq!(compare_names(&large, &larger), Ordering::Less);
    assert_eq!(units(&large, &larger), per_byte(2 * (LENGTH + 1)));
    // A common prefix that ends in a large number stops at its last digit.
    let (first, second) = (repeated('7', LENGTH, "1"), repeated('7', LENGTH, "2"));
    assert_eq!(compare_names(&first, &second), Ordering::Less);
    assert_eq!(units(&first, &second), 1 + LENGTH / PREFIX_BYTES_PER_UNIT);
    // A number after letters that differ only in case.
    let (first, second) = (repeated('X', LENGTH, "1"), repeated('x', LENGTH, "2"));
    assert_eq!(units(&first, &second), per_byte(LENGTH + 3));
}

#[test]
fn hostile_digit_runs_take_linear_work_with_no_allocation() {
    const HOSTILE: usize = 60_000;
    let pairs: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (repeated('0', HOSTILE, "1"), b"1".to_vec()),
        (repeated('0', HOSTILE, "1"), repeated('0', HOSTILE, "2")),
        (repeated('0', HOSTILE, "1"), repeated('0', HOSTILE / 2, "1")),
        (repeated('9', HOSTILE, ""), repeated('9', HOSTILE, "0")),
        (repeated('9', HOSTILE, "1"), repeated('9', HOSTILE, "2")),
        (repeated('1', HOSTILE, "a"), repeated('2', HOSTILE, "a")),
        (repeated('1', HOSTILE, ""), repeated('2', HOSTILE - 1, "")),
        (
            [
                repeated('0', HOSTILE / 2, "1a"),
                repeated('0', HOSTILE / 2, "1"),
            ]
            .concat(),
            b"1a1".to_vec(),
        ),
    ];
    for (a, b) in &pairs {
        let before = ALLOCATIONS.get();
        let (order, units) = compare_names_counted(a, b);
        assert_eq!(ALLOCATIONS.get(), before);
        assert_eq!(compare_names(b, a), order.reverse());
        // A comparison reads each byte of each name at most about two times.
        assert!(units <= 1 + 3 * HOSTILE / BYTES_PER_UNIT, "{units}");
        // Also in a debug build, a linear walk of 60 kB is far below this.
        // The best of some tries ignores one scheduling delay.
        let time = (0..5)
            .map(|_| {
                let start = Instant::now();
                std::hint::black_box(compare_names_counted(a, b));
                start.elapsed()
            })
            .min()
            .unwrap();
        assert!(time.as_millis() < 100, "{time:?}");
    }
}
