//! Which files an agent's tool call reads and writes — for the file lock that
//! lets several agents work in one project at once (agent_locks.rs).
//!
//! The answer only has to be safe, not exact: when a call can't be read with
//! confidence, it "writes everything" and simply waits for (and holds back) the
//! other agents' calls while it runs. Narrow answers just buy parallelism.
//!
//! - Read / Grep / Glob / LS: read their path (Grep and Glob: the folder they search).
//! - Edit / Write / MultiEdit / NotebookEdit: write their file.
//! - Bash: the command line is split into commands (quotes, `&&`, `|`, `;`,
//!   redirections, heredocs, `cd`), and each is recognised: read-only tools
//!   (`cat`, `ls`, `grep`, `rg`, `find` without `-exec`, …) read their
//!   arguments; `cp`, `mv`, `rm`, `mkdir`, `touch`, `tee`, `sed -i`, `>` write
//!   their targets; Python (`-c`, a heredoc, or a script file it reads first)
//!   writes what its code passes to `.save(…)`, `open(…, 'w')`, `to_excel(…)`
//!   and the like — when every such target is a literal path (directly, through
//!   a `name = "path"` assignment, `Path(…)` or `os.path.join` of literals) — and
//!   reads the path-like literals it names. Anything else (command substitution,
//!   unknown programs, a write to a computed path, subprocesses) is "everything".

use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::Value;

/// What a tool call touches. Paths are absolute; a folder covers everything under it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Access {
    pub reads: Vec<PathBuf>,
    pub writes: Vec<PathBuf>,
    /// Can't tell what it writes: treat it as writing everything.
    pub everything: bool,
}

impl Access {
    pub fn everything() -> Self {
        Self { everything: true, ..Default::default() }
    }
    pub fn writes_anything(&self) -> bool {
        self.everything || !self.writes.is_empty()
    }
    pub fn is_empty(&self) -> bool {
        !self.everything && self.reads.is_empty() && self.writes.is_empty()
    }
    fn merge(&mut self, o: Access) {
        self.everything |= o.everything;
        self.reads.extend(o.reads);
        self.writes.extend(o.writes);
    }
    /// A short description for the waiting notice ("deck.pptx", "everything").
    pub fn describe_writes(&self, root: &Path) -> String {
        if self.everything {
            return "files in the project".into();
        }
        let names: Vec<String> = self.writes.iter().map(|p| rel(root, p)).collect();
        match names.len() {
            0 => "nothing".into(),
            1..=3 => names.join(", "),
            n => format!("{} and {} more", names[..2].join(", "), n - 2),
        }
    }
}

/// A path for display: relative to the project folder when inside it.
pub fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| p.to_string_lossy().into_owned())
}

/// Whether two paths overlap: the same, or one inside the other.
pub fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// The files a tool call reads and writes (`root`: the project folder, the commands' starting directory).
pub fn classify(tool: &str, input: &Value, root: &Path) -> Access {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty());
    let at = |p: &str| norm(root, p);
    match tool {
        "Read" | "NotebookRead" => Access { reads: s("file_path").or(s("notebook_path")).map(at).into_iter().collect(), ..Default::default() },
        "Grep" | "Glob" | "LS" => Access { reads: vec![s("path").map(at).unwrap_or_else(|| root.to_path_buf())], ..Default::default() },
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => match s("file_path").or(s("notebook_path")) {
            Some(p) => Access { writes: vec![at(p)], ..Default::default() },
            None => Access::everything(),
        },
        "Bash" => s("command").map_or_else(Access::everything, |c| classify_shell(c, root)),
        // Web, tasks, todo lists, MCP tools: no files of the project.
        _ => Access::default(),
    }
}

/// An absolute, normalised path (`p` relative to `cwd`); a glob stands for its folder.
fn norm(cwd: &Path, p: &str) -> PathBuf {
    let p = p.strip_prefix("~/").map(|rest| dirs::home_dir().unwrap_or_default().join(rest).to_string_lossy().into_owned()).unwrap_or_else(|| p.to_string());
    let mut path = PathBuf::from(&p);
    if p.contains(['*', '?', '[']) {
        // The folder the glob is in (up to the first wildcard).
        let fixed: PathBuf = Path::new(&p).components().take_while(|c| !c.as_os_str().to_string_lossy().contains(['*', '?', '['])).collect();
        path = fixed;
    }
    let abs = if path.is_absolute() { path } else { cwd.join(path) };
    crate::permissions::resolve(&abs, &abs.to_string_lossy())
}

// ── shell ────────────────────────────────────────────────────────────────────

/// One simple command: its words, redirections and heredoc body.
#[derive(Debug, Default)]
struct Cmd {
    words: Vec<String>,
    /// ('<' read | '>' write, target)
    redirs: Vec<(char, String)>,
    heredoc: Option<String>,
}

/// Split a command line into simple commands; None when it can't be read safely
/// (command substitution, unbalanced quotes).
fn parse_shell(line: &str) -> Option<Vec<Cmd>> {
    let chars: Vec<char> = line.chars().collect();
    let mut cmds = vec![Cmd::default()];
    let mut word = String::new();
    let mut in_word = false;
    // Redirection waiting for its target: '<' / '>' / 'h' (heredoc delimiter) / 's' (here-string, ignored).
    let mut pending: Option<char> = None;
    // Heredocs declared on this line: (command index, delimiter, strip tabs).
    let mut heredocs: Vec<(usize, String, bool)> = Vec::new();
    let mut i = 0;

    fn finish(word: &mut String, in_word: &mut bool, pending: &mut Option<char>, cmds: &mut [Cmd], heredocs: &mut Vec<(usize, String, bool)>, strip: bool) {
        if !*in_word {
            return;
        }
        let w = std::mem::take(word);
        *in_word = false;
        let idx = cmds.len() - 1;
        match pending.take() {
            Some('h') => heredocs.push((idx, w, strip)),
            Some('s') => {}
            Some(op) => cmds[idx].redirs.push((op, w)),
            None => cmds[idx].words.push(w),
        }
    }

    let mut strip_tabs = false;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    word.push(chars[i]);
                    i += 1;
                }
                if i >= chars.len() {
                    return None;
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '`' || (chars[i] == '$' && chars.get(i + 1) == Some(&'(')) {
                        return None;
                    }
                    if chars[i] == '\\' && i + 1 < chars.len() && matches!(chars[i + 1], '"' | '\\' | '$' | '`') {
                        i += 1;
                    }
                    word.push(chars[i]);
                    i += 1;
                }
                if i >= chars.len() {
                    return None;
                }
            }
            '`' => return None,
            '$' if chars.get(i + 1) == Some(&'(') => return None,
            '\\' => {
                in_word = true;
                if let Some(&n) = chars.get(i + 1) {
                    if n != '\n' {
                        word.push(n);
                    }
                    i += 1;
                }
            }
            ' ' | '\t' => finish(&mut word, &mut in_word, &mut pending, &mut cmds, &mut heredocs, strip_tabs),
            '\n' | ';' | '&' | '|' => {
                finish(&mut word, &mut in_word, &mut pending, &mut cmds, &mut heredocs, strip_tabs);
                // `>&2`, `2>&1`: a file-descriptor duplication, not a separator.
                if c == '&' && i > 0 && matches!(chars[i - 1], '>' | '<') {
                    pending = None;
                    while i + 1 < chars.len() && (chars[i + 1].is_ascii_digit() || chars[i + 1] == '-') {
                        i += 1;
                    }
                    i += 1;
                    continue;
                }
                if !cmds.last().is_some_and(|c| c.words.is_empty() && c.redirs.is_empty()) {
                    cmds.push(Cmd::default());
                }
                if c == '\n' && !heredocs.is_empty() {
                    // The heredoc bodies follow, one after another, each up to its delimiter line.
                    let rest: String = chars[i + 1..].iter().collect();
                    let mut consumed = 0;
                    let mut lines = rest.split_inclusive('\n');
                    for (idx, delim, strip) in heredocs.drain(..) {
                        let mut body = String::new();
                        let mut closed = false;
                        for l in lines.by_ref() {
                            consumed += l.chars().count();
                            let t = l.trim_end_matches('\n');
                            let t = if strip { t.trim_start_matches('\t') } else { t };
                            if t == delim {
                                closed = true;
                                break;
                            }
                            body.push_str(l);
                        }
                        if !closed {
                            return None;
                        }
                        if let Some(cmd) = cmds.get_mut(idx) {
                            cmd.heredoc = Some(body);
                        }
                    }
                    i += 1 + consumed;
                    continue;
                }
            }
            '>' | '<' => {
                // `2>`: the digits are the descriptor, not a word.
                if in_word && word.chars().all(|d| d.is_ascii_digit()) {
                    word.clear();
                    in_word = false;
                } else {
                    finish(&mut word, &mut in_word, &mut pending, &mut cmds, &mut heredocs, strip_tabs);
                }
                if c == '<' && chars.get(i + 1) == Some(&'<') {
                    if chars.get(i + 2) == Some(&'<') {
                        pending = Some('s');
                        i += 3;
                        continue;
                    }
                    strip_tabs = chars.get(i + 2) == Some(&'-');
                    pending = Some('h');
                    i += if strip_tabs { 3 } else { 2 };
                    continue;
                }
                pending = Some(if c == '<' { '<' } else { '>' });
                if c == '>' && matches!(chars.get(i + 1), Some('>') | Some('|')) {
                    i += 1;
                }
            }
            _ => {
                in_word = true;
                word.push(c);
            }
        }
        i += 1;
    }
    finish(&mut word, &mut in_word, &mut pending, &mut cmds, &mut heredocs, strip_tabs);
    if !heredocs.is_empty() {
        return None; // a heredoc without its body
    }
    Some(cmds.into_iter().filter(|c| !c.words.is_empty() || !c.redirs.is_empty()).collect())
}

const READ_ONLY: &[&str] = &[
    "cat", "head", "tail", "less", "more", "wc", "ls", "file", "stat", "du", "df", "tree", "cut", "tr", "uniq", "diff", "cmp", "comm",
    "md5", "md5sum", "shasum", "sha256sum", "jq", "xxd", "hexdump", "od", "strings", "nl", "column", "fold", "realpath", "readlink",
    "zipinfo", "pdfinfo", "identify", "mdls", "open", "awk", "pdffonts", "exiftool",
];
/// Programs that touch no files (their arguments are text).
const NO_FILES: &[&str] = &[
    "echo", "printf", "pwd", "which", "whereis", "type", "date", "true", "false", "sleep", "basename", "dirname", "test", "[", "expr",
    "seq", "whoami", "uname", "hostname", "id", ":",
];
/// Programs whose first non-flag argument is a pattern, not a file.
const PATTERN_FIRST: &[&str] = &["grep", "egrep", "fgrep", "rg", "ag"];

fn classify_shell(line: &str, root: &Path) -> Access {
    let Some(cmds) = parse_shell(line) else { return Access::everything() };
    let mut out = Access::default();
    let mut cwd = root.to_path_buf();
    for cmd in cmds {
        out.merge(classify_cmd(&cmd, &mut cwd));
        if out.everything {
            return Access::everything();
        }
    }
    out
}

fn classify_cmd(cmd: &Cmd, cwd: &mut PathBuf) -> Access {
    let at = |p: &str| norm(cwd, p);
    let mut out = Access::default();
    for (op, target) in &cmd.redirs {
        if target == "/dev/null" || target.starts_with("/dev/std") {
            continue;
        }
        if *op == '<' { out.reads.push(at(target)) } else { out.writes.push(at(target)) }
    }
    // Skip variable assignments and wrappers.
    let mut words: Vec<&str> = cmd.words.iter().map(String::as_str).collect();
    while let Some(w) = words.first() {
        let assign = w.split_once('=').is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        if assign || matches!(*w, "time" | "nohup" | "exec" | "command" | "nice") {
            words.remove(0);
        } else {
            break;
        }
    }
    let Some(prog_path) = words.first() else { return out };
    // (Windows: `C:\\…\\python.exe` too — the name without its folder or `.exe`.)
    let prog = prog_path.rsplit(['/', '\\']).next().unwrap_or(prog_path);
    let prog = prog.strip_suffix(".exe").unwrap_or(prog);
    let args = &words[1..];
    let positional = || args.iter().filter(|a| !a.is_empty() && !a.starts_with('-')).copied().collect::<Vec<_>>();
    let has = |flag: &str| args.iter().any(|a| *a == flag || (flag.len() == 2 && a.starts_with('-') && !a.starts_with("--") && a.contains(&flag[1..])));

    match prog {
        "cd" => match args.first() {
            Some(d) if *d != "-" => {
                let to = at(d);
                *cwd = to;
            }
            _ => return Access::everything(), // `cd` home / back: where to, we don't track
        },
        p if NO_FILES.contains(&p) => {}
        p if READ_ONLY.contains(&p) => {
            if p == "awk" && args.iter().any(|a| a.contains('>') || a.contains("system")) {
                return Access::everything();
            }
            out.reads.extend(positional().into_iter().map(at));
        }
        p if PATTERN_FIRST.contains(&p) => {
            let mut pos = positional();
            if !args.iter().any(|a| *a == "-e" || *a == "-f" || a.starts_with("--regexp") || a.starts_with("--file")) && !pos.is_empty() {
                pos.remove(0);
            }
            if pos.is_empty() {
                out.reads.push(cwd.clone());
            }
            out.reads.extend(pos.into_iter().map(at));
        }
        "find" => {
            if args.iter().any(|a| matches!(*a, "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprint0" | "-fprintf" | "-fls")) {
                return Access::everything();
            }
            let roots: Vec<&str> = args.iter().take_while(|a| !a.starts_with('-') && !matches!(**a, "(" | "!")).copied().collect();
            if roots.is_empty() {
                out.reads.push(cwd.clone());
            }
            out.reads.extend(roots.into_iter().map(at));
        }
        "sed" => {
            let pos = positional();
            let files: Vec<&str> = if args.iter().any(|a| *a == "-e" || *a == "-f") { pos } else { pos.into_iter().skip(1).collect() };
            if args.iter().any(|a| a.starts_with("-i") || *a == "--in-place") {
                out.writes.extend(files.into_iter().map(at));
            } else {
                out.reads.extend(files.into_iter().map(at));
            }
        }
        "sort" => {
            if let Some(i) = args.iter().position(|a| *a == "-o") {
                out.writes.extend(args.get(i + 1).map(|p| at(p)));
            }
            out.reads.extend(positional().into_iter().map(at));
        }
        "cp" | "rsync" | "ln" | "install" | "convert" | "magick" => {
            let pos = positional();
            if let Some((dest, srcs)) = pos.split_last() {
                out.writes.push(at(dest));
                out.reads.extend(srcs.iter().map(|p| at(p)));
            }
        }
        "mv" | "rm" | "rmdir" | "unlink" | "mkdir" | "touch" | "tee" | "chmod" | "chown" => {
            let pos = positional();
            // chmod/chown: the first argument is the mode / owner.
            let skip = usize::from(matches!(prog, "chmod" | "chown"));
            out.writes.extend(pos.into_iter().skip(skip).map(at));
        }
        "zip" => {
            let pos = positional();
            if let Some((archive, files)) = pos.split_first() {
                out.writes.push(at(archive));
                out.reads.extend(files.iter().map(|p| at(p)));
            }
        }
        "unzip" => {
            if has("-l") || has("-p") || has("-t") || has("-Z") {
                out.reads.extend(positional().into_iter().map(at));
            } else {
                let dest = args.iter().position(|a| *a == "-d").and_then(|i| args.get(i + 1)).map(|d| at(d)).unwrap_or_else(|| cwd.clone());
                out.writes.push(dest);
                out.reads.extend(positional().into_iter().map(at));
            }
        }
        "soffice" | "libreoffice" => {
            let outdir = args.iter().position(|a| *a == "--outdir").and_then(|i| args.get(i + 1)).map(|d| at(d)).unwrap_or_else(|| cwd.clone());
            out.writes.push(outdir);
            let skip: Vec<usize> = args.iter().enumerate().filter(|(_, a)| matches!(**a, "--outdir" | "--convert-to")).map(|(i, _)| i + 1).collect();
            out.reads.extend(args.iter().enumerate().filter(|(i, a)| !a.starts_with('-') && !skip.contains(i)).map(|(_, a)| at(a)));
        }
        "pdftoppm" | "pdftocairo" => {
            let pos = positional();
            if let Some((prefix, srcs)) = pos.split_last() {
                out.writes.push(at(prefix).parent().map(Path::to_path_buf).unwrap_or_else(|| cwd.clone()));
                out.reads.extend(srcs.iter().map(|p| at(p)));
            }
        }
        "sips" => {
            match args.iter().position(|a| *a == "--out" || *a == "-o") {
                Some(i) => {
                    out.writes.extend(args.get(i + 1).map(|p| at(p)));
                    out.reads.extend(args.iter().enumerate().filter(|(j, a)| !a.starts_with('-') && *j != i + 1).map(|(_, a)| at(a)));
                }
                None if args.iter().any(|a| a.starts_with("-g") || *a == "--getProperty") => out.reads.extend(positional().into_iter().map(at)),
                None => out.writes.extend(positional().into_iter().map(at)), // sips edits in place
            }
        }
        "curl" | "wget" => {
            if let Some(i) = args.iter().position(|a| matches!(*a, "-o" | "--output" | "-O" | "--output-document")) {
                match args.get(i + 1) {
                    Some(p) if *args.get(i).unwrap() != "-O" || prog == "wget" => out.writes.push(at(p)),
                    _ => out.writes.push(cwd.clone()),
                }
            } else if prog == "wget" || has("-O") {
                out.writes.push(cwd.clone());
            }
        }
        p if p.starts_with("python") => out.merge(classify_python(args, cmd.heredoc.as_deref(), cwd)),
        _ => return Access::everything(),
    }
    out
}

// ── python ───────────────────────────────────────────────────────────────────

fn classify_python(args: &[&str], heredoc: Option<&str>, cwd: &Path) -> Access {
    let mut i = 0;
    while i < args.len() && args[i].starts_with('-') && !matches!(args[i], "-c" | "-m" | "-") {
        i += 1; // -u, -B, -I, …
    }
    let (code, mut extra) = match args.get(i) {
        Some(&"-c") => match args.get(i + 1) {
            Some(code) => (code.to_string(), Access::default()),
            None => return Access::everything(),
        },
        Some(&"-m") => return Access::everything(),
        Some(&"-") | None => match heredoc {
            Some(body) => (body.to_string(), Access::default()),
            None => return Access::everything(),
        },
        Some(script) => {
            let path = norm(cwd, script);
            match std::fs::read_to_string(&path) {
                Ok(code) if code.len() < 512 * 1024 => {
                    // The script itself, and any path-like arguments after it, are read.
                    let mut a = Access { reads: vec![path], ..Default::default() };
                    a.reads.extend(args[i + 1..].iter().filter(|x| !x.starts_with('-') && looks_like_path(x)).map(|x| norm(cwd, x)));
                    (code, a)
                }
                _ => return Access::everything(),
            }
        }
    };
    extra.merge(python_code_access(&code, cwd));
    extra
}

fn looks_like_path(s: &str) -> bool {
    static EXT: &[&str] = &[
        "pptx", "potx", "ppt", "xlsx", "xlsm", "xls", "csv", "docx", "doc", "pdf", "md", "txt", "json", "png", "jpg", "jpeg", "gif", "webp",
        "svg", "py", "html", "yaml", "yml", "xml", "zip", "tsv",
    ];
    if s.is_empty() || s.len() > 500 || s.contains('\n') || s.contains("://") {
        return false;
    }
    s.starts_with('/') || s.starts_with("./") || s.starts_with("../") || s.starts_with("~/") || s.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && EXT.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The text of each call's arguments for `name(` occurrences matched by `re` (balanced parentheses).
fn call_args(code: &str, start: usize) -> Option<Vec<String>> {
    let bytes: Vec<char> = code[start..].chars().collect();
    let mut depth = 0;
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                cur.push(bytes[i + 1]);
                i += 1;
            } else if c == q {
                quote = None;
            }
        } else {
            match c {
                '\'' | '"' => {
                    quote = Some(c);
                    cur.push(c);
                }
                '(' | '[' | '{' => {
                    depth += 1;
                    cur.push(c);
                }
                ')' | ']' | '}' if depth == 0 => {
                    if !cur.trim().is_empty() {
                        args.push(cur.trim().to_string());
                    }
                    return Some(args);
                }
                ')' | ']' | '}' => {
                    depth -= 1;
                    cur.push(c);
                }
                ',' if depth == 0 => args.push(std::mem::take(&mut cur).trim().to_string()),
                _ => cur.push(c),
            }
        }
        i += 1;
    }
    None
}

/// A string literal's value (plain, raw, or an f-string without placeholders).
fn literal(expr: &str) -> Option<String> {
    let e = expr.trim();
    let e = e.trim_start_matches(['r', 'R', 'u', 'U']);
    let (e, fstr) = match e.strip_prefix(['f', 'F']) {
        Some(rest) => (rest.trim_start_matches(['r', 'R']), true),
        None => (e, false),
    };
    let q = e.chars().next()?;
    if !matches!(q, '\'' | '"') || e.len() < 2 || !e.ends_with(q) {
        return None;
    }
    let inner = &e[1..e.len() - 1];
    if inner.contains(q) || (fstr && inner.contains('{')) {
        return None;
    }
    Some(inner.to_string())
}

/// A path expression's value: a literal, a variable assigned one, `Path(…)`, `os.path.join(…)` of those.
fn path_value(expr: &str, vars: &std::collections::HashMap<String, String>) -> Option<String> {
    let e = expr.trim();
    if let Some(v) = literal(e) {
        return Some(v);
    }
    if let Some(v) = vars.get(e) {
        return Some(v.clone());
    }
    for f in ["Path(", "pathlib.Path(", "str(", "os.path.abspath(", "os.path.expanduser("] {
        if let Some(inner) = e.strip_prefix(f).and_then(|r| r.strip_suffix(')')) {
            return path_value(inner, vars);
        }
    }
    if let Some(inner) = e.strip_prefix("os.path.join(").and_then(|r| r.strip_suffix(')')) {
        let parts = call_args(&format!("{inner})"), 0)?;
        let vals: Option<Vec<String>> = parts.iter().map(|p| path_value(p, vars)).collect();
        return vals.map(|v| v.iter().collect::<PathBuf>().to_string_lossy().into_owned());
    }
    // `base / "name.pptx"` with both known.
    if let Some((l, r)) = e.split_once(" / ") {
        return Some(PathBuf::from(path_value(l, vars)?).join(path_value(r, vars)?).to_string_lossy().into_owned());
    }
    None
}

fn python_code_access(code: &str, cwd: &Path) -> Access {
    use std::sync::OnceLock;
    static RES: OnceLock<[Regex; 6]> = OnceLock::new();
    let [assign, saves, opens, two_arg, one_arg, method] = RES.get_or_init(|| {
        [
            // name = "literal" / Path("literal") / os.path.join(...)
            Regex::new(r#"(?m)^\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:#.*)?$"#).unwrap(),
            // Writers taking the target first: .save( .savefig( .to_excel( .to_csv( .to_json( .to_parquet( .write_image( .to_file(
            Regex::new(r#"\.(save|savefig|to_excel|to_csv|to_json|to_parquet|to_html|write_image|to_file|write_pdf|to_pickle)\("#).unwrap(),
            // open-like calls with a mode
            Regex::new(r#"\b(open|io\.open|codecs\.open|gzip\.open|ZipFile|zipfile\.ZipFile|tarfile\.open)\("#).unwrap(),
            // (src, dst) copies / moves / renames
            Regex::new(r#"\b(shutil\.(?:copy|copy2|copyfile|copytree|move)|os\.(?:rename|replace))\("#).unwrap(),
            // one-path deleters / makers
            Regex::new(r#"\b(os\.(?:remove|unlink|makedirs|mkdir|rmdir|removedirs)|shutil\.rmtree)\("#).unwrap(),
            // pathlib methods that write: X.write_text( X.write_bytes( X.unlink( X.mkdir( X.touch( X.rmdir(
            // (not rename / replace: str.replace and DataFrame.rename are everywhere)
            Regex::new(r#"([A-Za-z_][\w.]*(?:\([^()]*\))?)\.(write_text|write_bytes|unlink|mkdir|touch|rmdir)\("#).unwrap(),
        ]
    });
    if code.contains("subprocess") || code.contains("os.system") || code.contains("os.popen") || code.contains("exec(") || code.contains("eval(") {
        return Access::everything();
    }
    // Variables holding a path (the last assignment wins; good enough for short scripts).
    let mut vars = std::collections::HashMap::new();
    for c in assign.captures_iter(code) {
        if let Some(v) = path_value(&c[2], &vars) {
            vars.insert(c[1].to_string(), v);
        }
    }
    let mut out = Access::default();
    let write = |expr: Option<&String>, out: &mut Access| -> bool {
        match expr.and_then(|e| path_value(e, &vars)) {
            Some(p) => {
                out.writes.push(norm(cwd, &p));
                true
            }
            None => false,
        }
    };
    for m in saves.find_iter(code) {
        let Some(args) = call_args(code, m.end()) else { return Access::everything() };
        // A `.save()` with no argument (openpyxl's Workbook keeps its own filename) or a buffer: unknown.
        let target = args.iter().find(|a| !a.contains('=') || a.starts_with("path=") || a.starts_with("fname=")).map(|a| a.split_once('=').map_or(a.clone(), |(_, v)| v.to_string()));
        if !write(target.as_ref(), &mut out) {
            return Access::everything();
        }
    }
    for m in opens.find_iter(code) {
        let Some(args) = call_args(code, m.end()) else { return Access::everything() };
        let mode = args.iter().skip(1).find(|a| !a.contains('=') || a.starts_with("mode=")).map(|a| a.trim_start_matches("mode=").to_string());
        let writing = mode.as_deref().and_then(literal).is_some_and(|m| m.contains(['w', 'a', 'x', '+']));
        if writing {
            if !write(args.first(), &mut out) {
                return Access::everything();
            }
        } else if let Some(p) = args.first().and_then(|a| path_value(a, &vars)) {
            out.reads.push(norm(cwd, &p));
        }
    }
    for m in two_arg.find_iter(code) {
        let Some(args) = call_args(code, m.end()) else { return Access::everything() };
        if !write(args.get(1), &mut out) {
            return Access::everything();
        }
        if m.as_str().contains("move") || m.as_str().contains("rename") || m.as_str().contains("replace") {
            if !write(args.first(), &mut out) {
                return Access::everything();
            }
        } else if let Some(p) = args.first().and_then(|a| path_value(a, &vars)) {
            out.reads.push(norm(cwd, &p));
        }
    }
    for m in one_arg.find_iter(code) {
        let Some(args) = call_args(code, m.end()) else { return Access::everything() };
        if !write(args.first(), &mut out) {
            return Access::everything();
        }
    }
    for c in method.captures_iter(code) {
        let recv = &c[1];
        if recv == "os" || recv == "shutil" || recv.starts_with("os.") {
            continue; // os.mkdir( … — covered above
        }
        let ok = path_value(recv, &vars).map(|p| out.writes.push(norm(cwd, &p))).is_some();
        if !ok {
            return Access::everything();
        }
    }
    // Every path-like literal is (at least) read.
    static LIT: OnceLock<Regex> = OnceLock::new();
    let lit = LIT.get_or_init(|| Regex::new(r#"(?:[rRfF]?)(?:"([^"\n]*)"|'([^'\n]*)')"#).unwrap());
    for c in lit.captures_iter(code) {
        let s = c.get(1).or(c.get(2)).map_or("", |m| m.as_str());
        if looks_like_path(s) {
            out.reads.push(norm(cwd, s));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().canonicalize().unwrap();
        (d, r)
    }
    fn bash(cmd: &str, root: &Path) -> Access {
        classify("Bash", &json!({ "command": cmd }), root)
    }
    fn names(root: &Path, v: &[PathBuf]) -> Vec<String> {
        let mut n: Vec<String> = v.iter().map(|p| rel(root, p)).collect();
        n.sort();
        n.dedup();
        n
    }

    #[test]
    fn built_in_tools() {
        let (_d, r) = root();
        let a = classify("Read", &json!({ "file_path": r.join("deck.pptx").to_string_lossy() }), &r);
        assert_eq!((names(&r, &a.reads), a.writes_anything()), (vec!["deck.pptx".to_string()], false));
        let a = classify("Edit", &json!({ "file_path": "notes.md" }), &r);
        assert_eq!(names(&r, &a.writes), vec!["notes.md"]);
        assert_eq!(classify("Grep", &json!({ "pattern": "x" }), &r).reads, vec![r.clone()]);
        assert!(classify("WebSearch", &json!({ "query": "x" }), &r).is_empty());
    }

    #[test]
    fn read_only_and_writing_commands() {
        let (_d, r) = root();
        let a = bash("ls -la slides && cat notes.md | head -20 && rg -n 'Revenue' deck.md", &r);
        assert!(!a.writes_anything());
        assert_eq!(names(&r, &a.reads), vec!["deck.md", "notes.md", "slides"]);
        let a = bash("cp deck.pptx backup/deck-v2.pptx && echo done > log.txt 2>&1", &r);
        assert_eq!(names(&r, &a.writes), vec!["backup/deck-v2.pptx", "log.txt"]);
        assert_eq!(names(&r, &a.reads), vec!["deck.pptx"]);
        let a = bash("cd sub && rm -f old.png && sed -i '' 's/a/b/' x.md", &r);
        assert_eq!(names(&r, &a.writes), vec!["sub/old.png", "sub/x.md"]);
        assert!(bash("find . -name '*.tmp' -delete", &r).everything);
        assert!(bash("rg TODO", &r).reads.contains(&r));
        assert_eq!(names(&r, &bash("ls *.pptx", &r).reads), vec![""]); // a glob: its folder
    }

    #[test]
    fn unknown_or_unsafe_is_everything() {
        let (_d, r) = root();
        for c in ["git checkout .", "npm install", "echo $(date) > x", "make", "python3 -m pip install x", "bash script.sh", "cat `ls`", "python3 missing_script.py"] {
            assert!(bash(c, &r).everything, "{c}");
        }
    }

    #[test]
    fn python_heredoc_and_c_code() {
        let (_d, r) = root();
        let a = bash("cd sub && python3 - <<'EOF'\nfrom pptx import Presentation\nprs = Presentation(\"deck.pptx\")\nprs.slides[0].shapes.title.text = 'Hi'\nprs.save(\"deck.pptx\")\nEOF", &r);
        assert!(!a.everything, "{a:?}");
        assert_eq!(names(&r, &a.writes), vec!["sub/deck.pptx"]);
        // A path in a variable; reads of other literals.
        let a = bash("python3 -c \"from pptx import Presentation\npath = 'deck.pptx'\np = Presentation(path)\nprint(open('notes.md').read())\np.save(path)\"", &r);
        assert_eq!(names(&r, &a.writes), vec!["deck.pptx"]);
        assert!(names(&r, &a.reads).contains(&"notes.md".to_string()));
        // Read-only inspection.
        let a = bash("python3 -c \"from pptx import Presentation; print(len(Presentation('deck.pptx').slides))\"", &r);
        assert!(!a.writes_anything());
        assert_eq!(names(&r, &a.reads), vec!["deck.pptx"]);
        // A computed target, or a subprocess: everything.
        assert!(bash("python3 -c \"import sys; p=sys.argv[1]; from pptx import Presentation; Presentation(p).save(p)\" deck.pptx", &r).everything);
        assert!(bash("python3 -c \"import subprocess; subprocess.run(['ls'])\"", &r).everything);
        // os.path.join / Path of literals, open for writing, to_excel.
        let a = bash("python3 - <<EOF\nimport os, pandas as pd\nfrom pathlib import Path\nout = os.path.join('build', 'table.xlsx')\npd.DataFrame().to_excel(out)\nPath('build/x.txt').write_text('hi')\nwith open('log.txt', 'a') as f: f.write('x')\nEOF", &r);
        assert!(!a.everything, "{a:?}");
        assert_eq!(names(&r, &a.writes), vec!["build/table.xlsx", "build/x.txt", "log.txt"]);
    }

    #[test]
    fn python_script_files_are_read_first() {
        let (_d, r) = root();
        std::fs::write(r.join("edit.py"), "from pptx import Presentation\nDECK = 'deck.pptx'\np = Presentation(DECK)\np.save(DECK)\n").unwrap();
        let a = bash("python3 edit.py", &r);
        assert_eq!(names(&r, &a.writes), vec!["deck.pptx"]);
        assert!(names(&r, &a.reads).contains(&"edit.py".to_string()));
        std::fs::write(r.join("dyn.py"), "import sys\nfrom pptx import Presentation\np = Presentation(sys.argv[1])\np.save(sys.argv[2])\n").unwrap();
        assert!(bash("python3 dyn.py a.pptx b.pptx", &r).everything);
    }

    #[test]
    fn overlap_is_by_path_prefix() {
        assert!(overlaps(Path::new("/p/a"), Path::new("/p/a/b.pptx")));
        assert!(overlaps(Path::new("/p/a.pptx"), Path::new("/p/a.pptx")));
        assert!(!overlaps(Path::new("/p/a.pptx"), Path::new("/p/ab.pptx")));
    }
}
