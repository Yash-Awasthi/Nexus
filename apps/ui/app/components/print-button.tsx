// SPDX-License-Identifier: Apache-2.0
/**
 * "Print / save as PDF" — and the automatic print layout that makes it worth pressing.
 *
 * There is no PDF library here on purpose: the browser already has a PDF writer, and the page
 * already has the data. What was missing was a layout where the sidebar, the buttons and the
 * dark background get out of the way, and a filename that is the document's name rather than
 * "Nexus". Both live here.
 */
import { FileDown, Printer } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  docToHtml,
  docToMarkdown,
  printDocument,
  printFileName,
  type PrintableDoc,
} from "~/lib/printable";

/** A button that opens the browser's print dialog for whatever is on screen. */
export function PrintButton({ doc }: { doc: PrintableDoc }) {
  return (
    <Button variant="outline" size="sm" onClick={() => printDocument(doc)}>
      <Printer className="mr-1.5 size-4" aria-hidden="true" />
      Print / PDF
    </Button>
  );
}

/** A small menu of the two non-print formats, for a document you want to keep or diff. */
export function ExportButtons({ doc }: { doc: PrintableDoc }) {
  const [copied, setCopied] = useState(false);

  const download = (html: string, extension: string, type: string) => {
    const blob = new Blob([html], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${printFileName(doc)}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          // The clipboard is the shortest path into a ticket, a doc or a diff.
          void navigator.clipboard?.writeText(docToMarkdown(doc)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <FileDown className="mr-1.5 size-4" aria-hidden="true" />
        {copied ? "Copied" : "Copy as Markdown"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => download(docToHtml(doc), "html", "text/html")}
        aria-label="Download as HTML"
      >
        HTML
      </Button>
    </>
  );
}
