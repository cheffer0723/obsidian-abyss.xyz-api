import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Handlebars from "handlebars";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

// Resolved against the working directory the same way every other on-disk asset in this
// project is (see engineDataPath in src/routes/backtests.ts) -- esbuild externalizes
// handlebars and bundles no template files, so this reads the real source file at runtime.
const templatePath = path.resolve(process.cwd(), "src/templates/report.hbs");
let compiledTemplate: Handlebars.TemplateDelegate | null = null;

async function template(): Promise<Handlebars.TemplateDelegate> {
  if (!compiledTemplate) {
    const source = await readFile(templatePath, "utf8");
    compiledTemplate = Handlebars.compile(source, { noEscape: false });
  }
  return compiledTemplate;
}

export type ReportData = { id: string; name: string; createdAt: string };

// Renders a FIXED, developer-authored template (report.hbs, never built from request data) with
// the run's fields as plain DATA values -- Handlebars substitutes them at the template's own
// {{placeholders}} and HTML-escapes them; a value that happens to contain "{{...}}" text is never
// re-parsed as template syntax, so it comes out unchanged, not evaluated. That is what keeps this
// safe from server-side template injection: there is no code path where request-controlled text
// becomes part of the template itself, only ever a value substituted into one.
export async function renderReportPdf(data: ReportData): Promise<Buffer> {
  const compiled = await template();
  const html = compiled(data);

  // wkhtmltopdf is invoked with execFile (an argument array, never a shell string), and the only
  // arguments are filenames THIS function generated -- never derived from request data -- so there
  // is no path by which request-controlled text reaches the command line or a shell.
  const dir = await mkdtemp(path.join(tmpdir(), "abyss-report-"));
  const htmlPath = path.join(dir, `${crypto.randomUUID()}.html`);
  const pdfPath = path.join(dir, `${crypto.randomUUID()}.pdf`);
  try {
    await writeFile(htmlPath, html, "utf8");
    await execFileAsync("wkhtmltopdf", ["--quiet", htmlPath, pdfPath], { timeout: 20_000 });
    return await readFile(pdfPath);
  } catch (error) {
    logger.error({ err: error }, "PDF rendering failed");
    throw new Error("Could not generate the PDF.");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
