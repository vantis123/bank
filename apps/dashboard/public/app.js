(() => {
  const formCard = document.getElementById('formCard');
  const statusCard = document.getElementById('statusCard');
  const resultCard = document.getElementById('resultCard');
  const errorCard = document.getElementById('errorCard');

  const form = document.getElementById('runForm');
  const platformSel = document.getElementById('platform');
  const last4Field = document.getElementById('last4Field');

  const headlineEl = document.getElementById('resultHeadline');
  const subtextEl = document.getElementById('resultSubtext');
  const verdictPill = document.getElementById('verdictPill');
  const statsEl = document.getElementById('resultStats');
  const pdfFrame = document.getElementById('pdfFrame');
  const downloadBtn = document.getElementById('downloadBtn');
  const openBtn = document.getElementById('openBtn');
  const resetBtn = document.getElementById('resetBtn');
  const errorBody = document.getElementById('errorBody');
  const errorReset = document.getElementById('errorReset');

  function show(card) {
    [formCard, statusCard, resultCard, errorCard].forEach((c) => c.classList.add('hidden'));
    card.classList.remove('hidden');
  }

  // IIQ requires last4 — toggle that field's visibility.
  platformSel.addEventListener('change', () => {
    last4Field.style.display = platformSel.value === 'iiq' ? 'flex' : 'none';
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.headed = form.querySelector('#headed').checked;

    show(statusCard);

    try {
      const resp = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await resp.json();

      if (!json.ok) {
        errorBody.textContent =
          (json.error || 'Bank could not complete the pull.') +
          (json.stage ? `  (stage: ${json.stage})` : '');
        show(errorCard);
        return;
      }

      headlineEl.textContent = json.verdictHeadline || 'Report ready';
      subtextEl.textContent = json.verdictSubtext || '';
      verdictPill.className = `verdict-pill ${json.verdict || ''}`;
      verdictPill.textContent = json.fundingRange || json.verdict;

      const negText =
        json.accountsNegative > 0
          ? `${json.accountsNegative} negative`
          : 'No negatives';
      statsEl.innerHTML = `
        <div class="stat"><div class="stat-num">${json.scores?.equifax ?? '—'}</div><div class="stat-label">Equifax</div></div>
        <div class="stat"><div class="stat-num">${json.scores?.experian ?? '—'}</div><div class="stat-label">Experian</div></div>
        <div class="stat"><div class="stat-num">${json.scores?.transunion ?? '—'}</div><div class="stat-label">TransUnion</div></div>
        <div class="stat"><div class="stat-num">${json.accountsTotal ?? 0}</div><div class="stat-label">${negText}</div></div>
      `;

      pdfFrame.src = json.pdfUrl;
      downloadBtn.href = json.pdfUrl;
      downloadBtn.download = json.pdfUrl.split('/').pop();
      openBtn.href = json.pdfUrl;

      show(resultCard);
    } catch (err) {
      errorBody.textContent = err && err.message ? err.message : String(err);
      show(errorCard);
    }
  });

  resetBtn?.addEventListener('click', () => show(formCard));
  errorReset?.addEventListener('click', () => show(formCard));
})();
