//! Std-only ELF64 LE static-ness checker. Usage: elfcheck <file> [--sym <substring>]...
//! Exit 0: x86-64 ELF64, no PT_INTERP, no DT_NEEDED. Exit 1: ELF but violates. Exit 2: not x86-64 ELF64 LE.
use std::{env, fs, process::exit};
fn u16le(b: &[u8], o: usize) -> Option<u16> { Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?)) }
fn u32le(b: &[u8], o: usize) -> Option<u32> { Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?)) }
fn u64le(b: &[u8], o: usize) -> Option<u64> { Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?)) }
fn run() -> Result<i32, String> {
    let a: Vec<String> = env::args().collect();
    let path = a.get(1).ok_or("usage: elfcheck <file> [--sym s]...")?;
    let mut syms = vec![];
    let mut i = 2;
    while i < a.len() { if a[i] == "--sym" { syms.push(a.get(i + 1).ok_or("--sym needs arg")?.clone()); i += 2 } else { return Err(format!("bad arg {}", a[i])) } }
    let b = fs::read(path).map_err(|e| e.to_string())?;
    if b.len() < 64 || &b[0..4] != b"\x7fELF" { println!("NOT_ELF"); return Ok(2); }
    let (class, data, machine, etype) = (b[4], b[5], u16le(&b, 18).unwrap(), u16le(&b, 16).unwrap());
    println!("ei_class={class} (2=ELF64) ei_data={data} (1=LE) e_type={etype} (2=EXEC 3=DYN) e_machine={machine} (62=x86-64)");
    if class != 2 || data != 1 || machine != 62 { println!("NOT_X86_64_ELF64_LE"); return Ok(2); }
    let phoff = u64le(&b, 32).ok_or("hdr")? as usize;
    let phentsize = u16le(&b, 54).ok_or("hdr")? as usize;
    let phnum = u16le(&b, 56).ok_or("hdr")? as usize;
    let mut bad = false;
    let (mut interp, mut dynamic, mut needed) = (0, 0, 0);
    // map vaddr->offset for PT_LOAD to read dynamic string table if needed
    let mut loads = vec![];
    for n in 0..phnum {
        let o = phoff + n * phentsize;
        let p_type = u32le(&b, o).ok_or("ph")?;
        let off = u64le(&b, o + 8).ok_or("ph")? as usize;
        let vaddr = u64le(&b, o + 16).ok_or("ph")? as usize;
        let filesz = u64le(&b, o + 32).ok_or("ph")? as usize;
        match p_type {
            1 => loads.push((vaddr, off, filesz)),
            3 => { interp += 1; let s = b.get(off..off + filesz.min(96)).ok_or("interp range")?; println!("PT_INTERP: {:?} (first {} bytes of {filesz})", String::from_utf8_lossy(s), s.len()); }
            2 => { dynamic += 1;
                let mut e = off;
                loop {
                    let tag = u64le(&b, e).ok_or("dyn range")?;
                    if tag == 0 { break }
                    if tag == 1 { needed += 1; println!("DT_NEEDED entry at {e:#x} val={:#x}", u64le(&b, e + 8).unwrap()); }
                    e += 16; if e >= off + filesz { break }
                } }
            _ => {}
        }
    }
    println!("program_headers={phnum} PT_INTERP={interp} PT_DYNAMIC={dynamic} DT_NEEDED={needed}");
    if interp > 0 || needed > 0 { bad = true; }
    // optional symbol scan via section headers
    if !syms.is_empty() {
        let shoff = u64le(&b, 40).ok_or("hdr")? as usize;
        let shentsize = u16le(&b, 58).ok_or("hdr")? as usize;
        let shnum = u16le(&b, 60).ok_or("hdr")? as usize;
        let mut names: Vec<String> = vec![];
        for n in 0..shnum {
            let o = shoff + n * shentsize;
            if u32le(&b, o + 4) == Some(2) {
                let off = u64le(&b, o + 24).unwrap() as usize; let size = u64le(&b, o + 32).unwrap() as usize;
                let link = u32le(&b, o + 40).unwrap() as usize; let ent = u64le(&b, o + 56).unwrap() as usize;
                let so = shoff + link * shentsize;
                let stroff = u64le(&b, so + 24).unwrap() as usize;
                for k in 0..(size / ent.max(1)) {
                    let nm = u32le(&b, off + k * ent).unwrap() as usize;
                    let st = &b[stroff + nm..]; let end = st.iter().position(|&c| c == 0).unwrap_or(0);
                    names.push(String::from_utf8_lossy(&st[..end]).into_owned());
                }
            }
        }
        println!("symtab_symbols={}", names.len());
        for s in &syms {
            let m: Vec<&String> = names.iter().filter(|n| n.contains(s.as_str())).collect();
            println!("SYM[{s}] matches={}", m.len());
            for x in m.iter().take(6) { println!("  {x}"); }
        }
    }
    println!("{}", if bad { "RESULT=FAIL (has PT_INTERP or DT_NEEDED)" } else { "RESULT=PASS (x86-64 ELF64, no PT_INTERP, no DT_NEEDED)" });
    Ok(if bad { 1 } else { 0 })
}
fn main() { match run() { Ok(c) => exit(c), Err(e) => { eprintln!("error: {e}"); exit(3) } } }
