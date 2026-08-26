/**
 * exporter.js — POST to /api/export, trigger download
 */
import { parseErrorBody } from "./utils.js";

const modal = document.getElementById("export-modal");
const progressBar = document.getElementById("export-progress-bar");
const statusEl = document.getElementById("export-status");

export async function startExport({ jobId, crop, trim, textBlocks }) {
  modal.classList.remove("hidden");
  progressBar.style.width = "30%";
  statusEl.textContent = "Sending to server…";

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, crop, trim, textBlocks }),
    });

    if (!res.ok) {
      throw new Error(await parseErrorBody(res, "Export failed"));
    }

    progressBar.style.width = "80%";
    statusEl.textContent = "Downloading…";

    const blob = await res.blob();
    progressBar.style.width = "100%";
    statusEl.textContent = "Done!";

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "export.mp4";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    setTimeout(() => resetModal(false), 1500);
  } catch (err) {
    progressBar.classList.remove("bg-indigo-500");
    progressBar.classList.add("bg-red-500");
    progressBar.style.width = "100%";
    statusEl.textContent = "Error: " + err.message;
    setTimeout(() => resetModal(true), 3000);
  }
}

function resetModal(isError) {
  modal.classList.add("hidden");
  progressBar.style.width = "0%";
  if (isError) {
    progressBar.classList.add("bg-indigo-500");
    progressBar.classList.remove("bg-red-500");
  }
}
