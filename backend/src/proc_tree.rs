//! The processes an agent's CLI started (its shell commands and what they run),
//! for stopping a turn gracefully: when the user stops an agent, its CLI goes at
//! once, but a command it was running (e.g. a script saving a deck) is let
//! finish — killing it mid-save would leave a broken file — unless the user
//! presses Kill. See `chat::run_turn`.
//!
//! The processes are found by parent links (`ps`; on Windows a process snapshot), not process
//! groups: that works however the CLI starts its shells.

use std::collections::HashMap;

/// (pid, parent pid) of every process.
#[cfg(not(windows))]
fn parent_links() -> Vec<(u32, u32)> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace().filter_map(|x| x.parse::<u32>().ok());
            Some((it.next()?, it.next()?))
        })
        .collect()
}

/// (pid, parent pid) of every process.
#[cfg(windows)]
fn parent_links() -> Vec<(u32, u32)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                out.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Every live descendant of `pid` (children, their children, …).
pub fn descendants(pid: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (p, pp) in parent_links() {
        if p != pp {
            children.entry(pp).or_default().push(p);
        }
    }
    let mut found = Vec::new();
    let mut queue = vec![pid];
    while let Some(p) = queue.pop() {
        for &c in children.get(&p).into_iter().flatten() {
            if !found.contains(&c) {
                found.push(c);
                queue.push(c);
            }
        }
    }
    found
}

/// Whether the process still exists.
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // Signal 0: only checks that the process exists (and isn't a zombie — they're reaped quickly).
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// Kill these processes (and anything they started since) right away.
pub fn kill_all(pids: &[u32]) {
    let mut all: Vec<u32> = pids.to_vec();
    for &p in pids {
        all.extend(descendants(p));
    }
    for p in all {
        #[cfg(unix)]
        unsafe {
            libc::kill(p as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
            let h = OpenProcess(PROCESS_TERMINATE, 0, p);
            if !h.is_null() {
                TerminateProcess(h, 1);
                CloseHandle(h);
            }
        }
        #[cfg(not(any(unix, windows)))]
        let _ = p;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn finds_and_kills_what_a_process_started() {
        // A shell that starts a long sleep: the sleep is its descendant.
        let mut sh = std::process::Command::new("sh").args(["-c", "sleep 30 & wait"]).spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let kids = descendants(sh.id());
        assert!(!kids.is_empty(), "the sleep is found");
        assert!(kids.iter().all(|&k| alive(k)));
        kill_all(&[sh.id()]);
        let _ = sh.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(kids.iter().all(|&k| !alive(k)), "the sleep was killed too");
    }
}
