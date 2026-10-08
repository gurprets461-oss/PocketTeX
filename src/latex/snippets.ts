// Accessory-bar keys, snippets and completion vocabulary for LaTeX.
// Snippet templates use @codemirror/autocomplete syntax: ${name} marks a field.

export interface BarKey {
  label: string;
  title: string;
  insert?: string;
  snippet?: string;
  action?: 'left' | 'right' | 'tab' | 'undo' | 'redo';
  wide?: boolean;
}

export const BAR_KEYS: BarKey[] = [
  { label: '⇥', title: 'Next field / indent', action: 'tab' },
  { label: '\\', title: 'Backslash', insert: '\\' },
  { label: '{', title: 'Open brace', insert: '{' },
  { label: '}', title: 'Close brace', insert: '}' },
  { label: '$', title: 'Math shift', insert: '$' },
  { label: '_', title: 'Subscript', insert: '_' },
  { label: '^', title: 'Superscript', insert: '^' },
  { label: '&', title: 'Alignment tab', insert: '&' },
  { label: '\\\\', title: 'Line break', insert: '\\\\' },
  { label: '\\ce{}', title: 'mhchem formula', snippet: '\\ce{${}}', wide: true },
  { label: '\\SI{}{}', title: 'siunitx quantity', snippet: '\\SI{${value}}{${unit}}', wide: true },
  {
    label: 'figure',
    title: 'Figure environment',
    wide: true,
    snippet:
      '\\begin{figure}[H]\n  \\centering\n  \\includegraphics[width=0.6\\textwidth]{${figures/file.jpg}}\n  \\caption{${Caption}}\n  \\label{fig:${label}}\n\\end{figure}\n',
  },
  {
    label: 'table',
    title: 'Table environment (booktabs + siunitx)',
    wide: true,
    snippet:
      '\\begin{table}[H]\n  \\centering\n  \\caption{${Caption}}\n  \\label{tab:${label}}\n  \\begin{tabular}{l S[table-format=3.2] S[table-format=3.2]}\n    \\toprule\n    {${Quantity}} & {${A}} & {${B}} \\\\\n    \\midrule\n    ${row} & 0.00 & 0.00 \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}\n',
  },
  { label: '←', title: 'Cursor left', action: 'left' },
  { label: '→', title: 'Cursor right', action: 'right' },
  { label: '↶', title: 'Undo', action: 'undo' },
  { label: '↷', title: 'Redo', action: 'redo' },
];

export function figureSnippet(path: string): string {
  return (
    '\\begin{figure}[H]\n  \\centering\n  \\includegraphics[width=0.6\\textwidth]{' +
    path +
    '}\n  \\caption{${Caption}}\n  \\label{fig:${label}}\n\\end{figure}\n'
  );
}

/** Commands offered after a backslash: [name, snippet template or null]. */
export const COMMANDS: [string, string | null][] = [
  ['section', '\\section{${}}'],
  ['subsection', '\\subsection{${}}'],
  ['subsubsection', '\\subsubsection{${}}'],
  ['paragraph', '\\paragraph{${}}'],
  ['label', '\\label{${}}'],
  ['ref', '\\ref{${}}'],
  ['eqref', '\\eqref{${}}'],
  ['cref', '\\cref{${}}'],
  ['cite', '\\cite{${}}'],
  ['ce', '\\ce{${}}'],
  ['SI', '\\SI{${}}{${}}'],
  ['si', '\\si{${}}'],
  ['qty', '\\qty{${}}{${}}'],
  ['num', '\\num{${}}'],
  ['unit', '\\unit{${}}'],
  ['SIrange', '\\SIrange{${}}{${}}{${}}'],
  ['chemfig', '\\chemfig{${}}'],
  ['textbf', '\\textbf{${}}'],
  ['textit', '\\textit{${}}'],
  ['emph', '\\emph{${}}'],
  ['texttt', '\\texttt{${}}'],
  ['textsubscript', '\\textsubscript{${}}'],
  ['textsuperscript', '\\textsuperscript{${}}'],
  ['frac', '\\frac{${}}{${}}'],
  ['sqrt', '\\sqrt{${}}'],
  ['text', '\\text{${}}'],
  ['mathrm', '\\mathrm{${}}'],
  ['includegraphics', '\\includegraphics[width=${0.6}\\textwidth]{${}}'],
  ['caption', '\\caption{${}}'],
  ['footnote', '\\footnote{${}}'],
  ['item', '\\item '],
  ['input', '\\input{${}}'],
  ['include', '\\include{${}}'],
  ['usepackage', '\\usepackage{${}}'],
  ['begin', null],
  ['end', null],
  ['centering', null],
  ['toprule', null],
  ['midrule', null],
  ['bottomrule', null],
  ['hline', null],
  ['textwidth', null],
  ['linewidth', null],
  ['maketitle', null],
  ['tableofcontents', null],
  ['newpage', null],
  ['noindent', null],
  ['times', null],
  ['cdot', null],
  ['pm', null],
  ['degree', null],
  ['celsius', null],
  ['percent', null],
  ['gram', null],
  ['milli', null],
  ['micro', null],
  ['litre', null],
  ['mole', null],
  ['per', null],
  ['alpha', null],
  ['beta', null],
  ['gamma', null],
  ['delta', null],
  ['Delta', null],
  ['lambda', null],
  ['mu', null],
  ['nu', null],
  ['pi', null],
  ['sigma', null],
  ['rightarrow', null],
  ['leftrightarrow', null],
  ['approx', null],
  ['leq', null],
  ['geq', null],
  ['bibliography', '\\bibliography{${}}'],
  ['bibliographystyle', '\\bibliographystyle{${plain}}'],
];

export const ENVIRONMENTS = [
  'figure', 'table', 'tabular', 'equation', 'equation*', 'align', 'align*', 'itemize', 'enumerate',
  'description', 'center', 'abstract', 'minipage', 'subfigure', 'gather', 'multline', 'scheme',
  'verbatim', 'quote', 'thebibliography',
];
