//! The processes an agent's CLI started (its shell commands and what they run),
//! for stopping a turn gracefully: when the user stops an agent, its CLI goes at
//! once, but a command it was running (e.g. a script saving a deck) is let
//! finish — killing it mid-save would leave a broken file — unless the user
//! presses Kill. See `chat::run_turn`.
//!
//! The processes are found by parent links (`ps`), not process groups: that
//! works however the CLI starts its shells.

use std::collections::HashMap;

/// Every live descendant of `pid` (children, their children, …).
pub fn descendants(pid: u32) -> Vec<u32> {
    let Ok(out) = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output() else { return Vec::new() };
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut it = line.split_whitespace().filter_map(|x| x.parse::<u32>().ok());
        if let (Some(p), Some(pp)) = (it.next(), it.next()) {
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
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Kill these processes (and anything they started since) right away.
pub fn kill_all(pids: &[u32]) {
    #[cfg(unix)]
    {
        let mut all: Vec<u32> = pids.to_vec();
        for &p in pids {
            all.extend(descendants(p));
        }
        for p in all {
            unsafe {
                libc::kill(p as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pids;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(unix)]
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
