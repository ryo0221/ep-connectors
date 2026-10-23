// EditorPlatform の Host port から写した型を、元のリポジトリと比べる（または写し直す）。
//
//   node packages/editor-ports/scripts/upstream.mjs <editor-platform の checkout>          比べる
//   node packages/editor-ports/scripts/upstream.mjs <editor-platform の checkout> --write  写し直す
//
// 比べるのは comment を除いた宣言だけで、整形や comment の違いは差分にしない。EditorPlatform は
// private なので、この script は EditorPlatform を読める権限のある場所でだけ動かす（試験の設計 4）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import ts from 'typescript';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageDir, 'upstream.json');
const args = process.argv.slice(2);
const write = args.includes('--write');
const [upstreamDir, ...rest] = args.filter((a) => a !== '--write');
if (!upstreamDir || rest.length) {
  console.error('usage: upstream.mjs <editor-platform checkout> [--write]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const git = (...args) =>
  execFileSync('git', ['-C', upstreamDir, ...args], { encoding: 'utf8' }).trim();

/** リポジトリの prettier の設定で整えて書く。 */
async function format(path, text) {
  const options = await prettier.resolveConfig(path);
  writeFileSync(path, await prettier.format(text, { ...options, filepath: path }));
}
const parse = (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
const printer = ts.createPrinter({ removeComments: true });

/** 最上位の宣言を名前で引く。宣言の前の JSDoc も含めた元の文字列を持つ。 */
function declarations(file) {
  const result = new Map();
  for (const statement of file.statements) {
    const name = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]?.name.getText(file)
      : statement.name?.getText(file);
    if (!name) continue;
    result.set(name, {
      statement,
      text: file.text.slice(statement.getFullStart(), statement.getEnd()).trim(),
      exported: ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Export,
    });
  }
  return result;
}
const normalized = (file, { statement }) =>
  printer.printNode(ts.EmitHint.Unspecified, statement, file);

const problems = [];
const commit = git('rev-parse', 'HEAD');
for (const copy of manifest.copies) {
  const targetPath = join(packageDir, copy.target);
  const target = parse(targetPath, readFileSync(targetPath, 'utf8'));
  const copied = declarations(target);
  const listed = new Set(copy.sources.flatMap((s) => s.symbols));
  for (const [name, declaration] of copied)
    if (declaration.exported && !listed.has(name))
      problems.push(`${copy.target}: ${name} is not listed in upstream.json`);

  const sections = [];
  for (const source of copy.sources) {
    const file = parse(source.path, readFileSync(join(upstreamDir, source.path), 'utf8'));
    const upstream = declarations(file);
    const texts = [];
    for (const name of source.symbols) {
      const original = upstream.get(name);
      if (!original?.exported) {
        problems.push(`${source.path}: ${name} is no longer exported`);
        continue;
      }
      texts.push(original.text);
      const mine = copied.get(name);
      if (!mine) problems.push(`${copy.target}: ${name} is missing`);
      else if (normalized(file, original) !== normalized(target, mine))
        problems.push(`${copy.target}: ${name} differs from ${source.path}`);
    }
    if (write) source.lastChanged = git('log', '-1', '--format=%H', '--', source.path);
    sections.push(`// ${source.path}\n\n${texts.join('\n')}`);
  }
  if (write)
    await format(
      targetPath,
      [
        [
          '// EditorPlatform の Host port から写した、公開してよい型。手で直さず',
          '// `npm run editor-ports:sync -- <editor-platform の checkout>` で写し直す。',
          '// 写した元の commit と symbol は upstream.json にある。',
        ].join('\n'),
        ...sections,
      ].join('\n\n') + '\n',
    );
}

if (write) {
  manifest.commit = commit;
  manifest.copiedOn = new Date().toISOString().slice(0, 10);
  await format(manifestPath, JSON.stringify(manifest));
  console.log(`copied from ${commit}`);
  process.exit(problems.some((p) => p.includes('no longer exported')) ? 1 : 0);
}
console.log(`recorded ${manifest.commit}, checkout ${commit}`);
for (const problem of problems) console.error(problem);
if (problems.length) {
  console.error('The fixed port contract drifted. Run editor-ports:sync and open a PR.');
  process.exit(1);
}
console.log('The fixed port contract matches the checkout.');
