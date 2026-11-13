import * as fonts from './fonts';

const sample = 'Hamburgefonstiv — Ťłąčž Şțăî Ứửữ';
const rows = fonts;

export default function Page() {
  return (
    <main>
      {Object.entries(rows).map(([name, f]) => (
        <p key={name} className={f.className + ' ' + (f.variable ?? '')} data-family={JSON.stringify(f.style)}>
          <code>{name}</code> {sample}
        </p>
      ))}
    </main>
  );
}
