// Thin googleapis wrappers: Google Workspace READ-ONLY access (Drive list, Docs/Sheets/Slides read).
const { google } = require('googleapis');
const oauth = require('./oauth');

// List recent Drive files for an account, optionally filtered by a name-contains query.
async function listDriveFiles({ account, query, max = 20 } = {}) {
  const entry = oauth.clientFor(account);
  if (!entry) return { connected: false, files: [] };
  try {
    const drive = google.drive({ version: 'v3', auth: entry.client });
    const { data } = await drive.files.list({
      q: query ? `name contains '${String(query).replace(/'/g, "\\'")}'` : undefined,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      pageSize: max,
      orderBy: 'modifiedTime desc',
    });
    return { connected: true, files: data.files || [] };
  } catch (e) {
    return { connected: true, files: [], error: e.message };
  }
}

// Read a Google Doc and flatten its body into plain text.
async function readDoc({ account, documentId } = {}) {
  const entry = oauth.clientFor(account);
  if (!entry) return { connected: false, title: '', text: '' };
  try {
    const docs = google.docs({ version: 'v1', auth: entry.client });
    const { data } = await docs.documents.get({ documentId });
    let text = '';
    for (const el of ((data.body && data.body.content) || [])) {
      if (!el.paragraph) continue;
      for (const pe of (el.paragraph.elements || [])) {
        if (pe.textRun && pe.textRun.content) text += pe.textRun.content;
      }
    }
    return { connected: true, title: data.title || '', text };
  } catch (e) {
    return { connected: true, title: '', text: '', error: e.message };
  }
}

// Read a range of values from a Google Sheet.
async function readSheet({ account, spreadsheetId, range } = {}) {
  const entry = oauth.clientFor(account);
  if (!entry) return { connected: false, range, values: [] };
  try {
    const sheets = google.sheets({ version: 'v4', auth: entry.client });
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return { connected: true, range: data.range || range, values: data.values || [] };
  } catch (e) {
    return { connected: true, range, values: [], error: e.message };
  }
}

// Read a Google Slides presentation, extracting plain text per slide.
async function readSlides({ account, presentationId } = {}) {
  const entry = oauth.clientFor(account);
  if (!entry) return { connected: false, title: '', slides: [] };
  try {
    const slides = google.slides({ version: 'v1', auth: entry.client });
    const { data } = await slides.presentations.get({ presentationId });
    const out = [];
    for (const page of (data.slides || [])) {
      let text = '';
      for (const pe of (page.pageElements || [])) {
        const els = (pe.shape && pe.shape.text && pe.shape.text.textElements) || [];
        for (const te of els) {
          if (te.textRun && te.textRun.content) text += te.textRun.content;
        }
      }
      out.push(text);
    }
    return { connected: true, title: data.title || '', slides: out };
  } catch (e) {
    return { connected: true, title: '', slides: [], error: e.message };
  }
}

module.exports = { listDriveFiles, readDoc, readSheet, readSlides };
