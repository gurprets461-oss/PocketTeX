// Compile driver shared by the browser worker (engine-worker.js) and the
// Node build tooling (scripts/texlive/*). Decides how many pdfLaTeX passes to
// run and when to run BibTeX, in the spirit of latexmk:
//   * rerun while the .aux/.toc/.lof/.lot/.out files keep changing, or the log
//     explicitly asks for a rerun (up to MAX_PASSES);
//   * run BibTeX when the .aux has \citation + \bibdata and the citations,
//     style or .bib contents changed since the last BibTeX run.
// Plain ES2017 so it can be loaded with importScripts() or require().
(function (root) {
  'use strict';

  var MAX_PASSES = 5;
  var AUX_EXTS = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm'];

  // pdfTeX writes <jobname>.aux/.log/.pdf into the working directory (the
  // project root), even for a main file in a sub-folder, as on Overleaf.
  function stem(mainFile) {
    return mainFile.replace(/\.tex$/i, '').split('/').pop();
  }

  function hashBytes(bytes) {
    // FNV-1a over the bytes; good enough to detect changes.
    if (!bytes) return 'none';
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ':' + bytes.length;
  }

  function decode(bytes, encoding) {
    if (!bytes) return '';
    return new TextDecoder(encoding || 'latin1').decode(bytes);
  }

  function auxSnapshot(engine, base) {
    return AUX_EXTS.map(function (ext) {
      return ext + '=' + hashBytes(engine.readFile(base + ext));
    }).join('|');
  }

  /** Collect \citation/\bibdata/\bibstyle lines from the main .aux and \@input'ed sub-aux files. */
  function bibInputs(engine, base) {
    var seen = {};
    var lines = [];
    var bibdata = [];
    function visit(auxName) {
      if (seen[auxName]) return;
      seen[auxName] = true;
      var text = decode(engine.readFile(auxName));
      text.split('\n').forEach(function (line) {
        if (/^\\(citation|bibdata|bibstyle)\{/.test(line)) lines.push(line);
        var m = /^\\bibdata\{([^}]*)\}/.exec(line);
        if (m) bibdata = bibdata.concat(m[1].split(','));
        var inc = /^\\@input\{([^}]*)\}/.exec(line);
        if (inc) visit(inc[1]);
      });
    }
    visit(base + '.aux');
    var hasCites = lines.some(function (l) { return l.indexOf('\\citation{') === 0; });
    var hasData = bibdata.length > 0;
    if (!hasCites || !hasData) return null;
    var bibKey = bibdata.map(function (name) {
      name = name.trim();
      var file = /\.bib$/i.test(name) ? name : name + '.bib';
      return file + '=' + hashBytes(engine.readFile(file));
    });
    return lines.join('\n') + '\n' + bibKey.join('|');
  }

  function rerunRequested(log) {
    return /Rerun to get|Label\(s\) may have changed|Please rerun LaTeX|rerun LaTeX|Rerun LaTeX/.test(log);
  }

  /**
   * engine: {
   *   latex(main) -> { status, log }, bibtex(main) -> { status, log },
   *   readFile(path) -> Uint8Array|null
   * }
   * state: object kept by the caller between compiles (remembers the last
   *        BibTeX inputs so unchanged bibliographies are not re-run).
   */
  function compile(engine, mainFile, state, onProgress) {
    state = state || {};
    var base = stem(mainFile);
    var passes = 0;
    var bibtexRan = false;
    var bibtexLog = '';
    var result = null;
    var note = onProgress || function () {};

    while (passes < MAX_PASSES) {
      var before = auxSnapshot(engine, base);
      passes++;
      note({ phase: 'latex', pass: passes });
      result = engine.latex(mainFile);
      if (result.status !== 0) break;

      var changed = auxSnapshot(engine, base) !== before;
      var bibKey = bibInputs(engine, base);
      if (bibKey && (bibKey !== state.lastBibKey || !engine.readFile(base + '.bbl'))) {
        note({ phase: 'bibtex', pass: passes });
        var b = engine.bibtex(base + '.tex'); // BibTeX reads <jobname>.aux from the working directory
        bibtexRan = true;
        bibtexLog = decode(engine.readFile(base + '.blg'), 'utf-8') || b.log;
        state.lastBibKey = bibKey;
        // A new .bbl needs at least two more passes (citations, then labels).
        continue;
      }
      // Stop once the auxiliary files are stable. A log that still asks for a
      // rerun gets one more pass, but never loops on an unchanged .aux.
      if (!changed && (!rerunRequested(result.log) || passes >= 3)) break;
    }

    var logFile = decode(engine.readFile(base + '.log'), 'utf-8');
    return {
      status: result ? result.status : -1,
      passes: passes,
      bibtex: bibtexRan,
      bibtexLog: bibtexLog,
      log: logFile || (result ? result.log : ''),
      pdf: result && result.status === 0 ? engine.readFile(base + '.pdf') : null,
    };
  }

  // kpathsea format numbers (kpse_file_format_type in the engine's kpathsea)
  // and the default suffix kpathsea would append for each of them.
  var SUFFIX = {
    3: ['.tfm'], 4: ['.afm'], 6: ['.bib'], 7: ['.bst'], 10: ['.fmt'], 11: ['.map'],
    25: ['.eps'], 26: ['.tex'], 32: ['.pfb', '.pfa'], 33: ['.vf'], 36: ['.ttf'],
    44: ['.enc'], 47: ['.otf'], 48: ['.cfg'],
  };

  /** File names to try, in order, for an engine lookup of `name` in kpathsea `format`. */
  function candidates(name, format) {
    var sfx = SUFFIX[format] || [];
    var hasDot = name.lastIndexOf('.') > 0;
    var withSuffix = sfx
      .filter(function (s) { return name.slice(-s.length) !== s; })
      .map(function (s) { return name + s; });
    return hasDot ? [name].concat(withSuffix) : withSuffix.concat([name]);
  }

  var api = { compile: compile, candidates: candidates, MAX_PASSES: MAX_PASSES, hashBytes: hashBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PocketTeXDriver = api;
})(typeof self !== 'undefined' ? self : this);
