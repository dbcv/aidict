(() => {
    const STORAGE_HOST_KEY = "aidict_ollama_host";
    const STORAGE_MODEL_KEY = "aidict_ollama_model";

    const defaultHost = document.body.dataset.defaultHost || "http://localhost:11434";
    const defaultModel = document.body.dataset.defaultModel || "nemotron3:33b";

    const state = {
        currentKatakana: "",
        entries: [],
        currentIndex: 0,
        words: [],
        editingEntryId: null,
        isLoading: false,
    };

    // DOM references
    const ollamaHostInput = document.getElementById("ollama-host");
    const modelSelect = document.getElementById("model-select");
    const refreshModelsBtn = document.getElementById("refresh-models-btn");
    const modelStatus = document.getElementById("model-status");

    const sidebar = document.getElementById("sidebar");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    const sidebarFilter = document.getElementById("sidebar-filter");
    const wordListEl = document.getElementById("word-list");
    const wordCountEl = document.getElementById("word-count");

    const searchForm = document.getElementById("search-form");
    const wordInput = document.getElementById("word-input");
    const searchBtn = document.getElementById("search-btn");
    const statusBanner = document.getElementById("status-banner");
    const viewerEl = document.getElementById("viewer");

    const editModal = document.getElementById("edit-modal");
    const editForm = document.getElementById("edit-form");
    const editKatakanaInput = document.getElementById("edit-katakana");
    const editWrittenFormsEl = document.getElementById("edit-written-forms");
    const editNotesInput = document.getElementById("edit-notes");
    const addFormBtn = document.getElementById("add-form-btn");
    const editCloseBtn = document.getElementById("edit-close-btn");
    const editCancelBtn = document.getElementById("edit-cancel-btn");

    // Strict HTML escaping to prevent XSS
    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function formatDate(isoStr) {
        if (!isoStr) return "";
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return isoStr;
        return d.toLocaleString("ja-JP", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    function showBanner(message, isError = false) {
        statusBanner.textContent = message;
        statusBanner.classList.remove("hidden", "error");
        if (isError) statusBanner.classList.add("error");
    }

    function hideBanner() {
        statusBanner.classList.add("hidden");
    }

    function setLoading(loading, message = "") {
        state.isLoading = loading;
        searchBtn.disabled = loading;
        const regenBtn = document.getElementById("regenerate-btn");
        if (regenBtn) regenBtn.disabled = loading;
        if (loading && message) {
            showBanner(message, false);
        }
    }

    // Settings (Ollama host & model)
    function initSettings() {
        const savedHost = localStorage.getItem(STORAGE_HOST_KEY) || defaultHost;
        ollamaHostInput.value = savedHost;

        const savedModel = localStorage.getItem(STORAGE_MODEL_KEY) || defaultModel;
        populateModelSelect([savedModel], savedModel);
        loadModels(savedHost, savedModel);
    }

    function populateModelSelect(models, preferred) {
        modelSelect.innerHTML = "";
        const unique = Array.from(new Set(models.filter(Boolean)));
        if (preferred && !unique.includes(preferred)) {
            unique.unshift(preferred);
        }
        if (unique.length === 0) {
            unique.push(defaultModel);
        }
        unique.forEach((name) => {
            const opt = document.createElement("option");
            opt.value = name;
            opt.textContent = name;
            modelSelect.appendChild(opt);
        });
        if (preferred && unique.includes(preferred)) {
            modelSelect.value = preferred;
        }
    }

    async function loadModels(host, preferredModel) {
        modelStatus.textContent = "モデル読込中...";
        modelStatus.classList.remove("error");
        try {
            const res = await fetch(`/api/models?host=${encodeURIComponent(host)}`);
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "モデル取得に失敗しました");
            }
            const current = preferredModel || modelSelect.value || defaultModel;
            populateModelSelect(data.models, current);
            modelStatus.textContent = `${data.models.length}件取得`;
        } catch (err) {
            modelStatus.textContent = "接続不可";
            modelStatus.classList.add("error");
            console.warn(err);
        }
    }

    // Sidebar word list
    async function loadWords(query = "") {
        try {
            const res = await fetch(`/api/words?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            state.words = data.words || [];
            renderWordList();
        } catch (err) {
            console.error(err);
        }
    }

    function renderWordList() {
        wordCountEl.textContent = String(state.words.length);
        wordListEl.innerHTML = "";

        if (state.words.length === 0) {
            const li = document.createElement("li");
            li.className = "word-item";
            li.textContent = "該当する登録語がありません";
            wordListEl.appendChild(li);
            return;
        }

        state.words.forEach((item) => {
            const li = document.createElement("li");
            li.className = "word-item" + (item.katakana === state.currentKatakana ? " active" : "");

            const top = document.createElement("div");
            top.className = "word-item-top";

            const title = document.createElement("span");
            title.className = "word-item-katakana";
            title.textContent = item.katakana;

            const badge = document.createElement("span");
            badge.className = "badge" + (item.entry_count > 1 ? " badge-blue" : "");
            badge.textContent = `${item.entry_count}件`;

            top.appendChild(title);
            top.appendChild(badge);
            li.appendChild(top);

            if (item.preview_forms && item.preview_forms.length > 0) {
                const forms = document.createElement("div");
                forms.className = "word-item-forms";
                forms.textContent = item.preview_forms.join("・");
                li.appendChild(forms);
            }

            li.addEventListener("click", () => {
                wordInput.value = item.katakana;
                loadEntriesByWord(item.katakana);
                closeSidebar();
            });

            wordListEl.appendChild(li);
        });
    }

    async function loadEntriesByWord(word, focusEntryId = null) {
        hideBanner();
        try {
            const res = await fetch(`/api/entries?word=${encodeURIComponent(word)}`);
            const data = await res.json();
            state.currentKatakana = data.katakana || "";
            state.entries = data.entries || [];
            if (focusEntryId !== null) {
                const idx = state.entries.findIndex((e) => e.id === focusEntryId);
                state.currentIndex = idx >= 0 ? idx : 0;
            } else {
                state.currentIndex = 0;
            }
            renderWordList();
            renderViewer();
        } catch (err) {
            showBanner(`読み込みに失敗しました: ${err.message}`, true);
        }
    }

    async function searchOrGenerate(word, force = false) {
        const trimmed = word.trim();
        if (!trimmed) return;

        const host = ollamaHostInput.value.trim() || defaultHost;
        const model = modelSelect.value || defaultModel;

        localStorage.setItem(STORAGE_HOST_KEY, host);
        localStorage.setItem(STORAGE_MODEL_KEY, model);

        setLoading(
            true,
            force
                ? `「${trimmed}」を ${model} で追加生成中...`
                : `「${trimmed}」を検索中（未登録の場合は ${model} で生成します）...`
        );

        try {
            const res = await fetch("/api/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    word: trimmed,
                    model,
                    ollama_host: host,
                    force,
                }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || "生成に失敗しました");
            }

            state.currentKatakana = data.katakana;
            state.entries = data.entries || [];
            if (data.created_entry_id) {
                const idx = state.entries.findIndex((e) => e.id === data.created_entry_id);
                state.currentIndex = idx >= 0 ? idx : 0;
            } else {
                state.currentIndex = 0;
            }

            wordInput.value = data.katakana;
            if (data.cached) {
                showBanner(`キャッシュから表示しました（${state.entries.length}件のエントリ）`);
            } else {
                showBanner(`${model} で新しいエントリを追加しました（計${state.entries.length}件）`);
            }

            await loadWords(sidebarFilter.value);
            renderViewer();
        } catch (err) {
            showBanner(err.message || "エラーが発生しました", true);
        } finally {
            setLoading(false);
        }
    }

    function switchEntry(delta) {
        if (state.entries.length <= 1) return;
        const len = state.entries.length;
        state.currentIndex = (state.currentIndex + delta + len) % len;
        renderViewer();
    }

    function jumpToEntry(index) {
        if (index < 0 || index >= state.entries.length) return;
        state.currentIndex = index;
        renderViewer();
    }

    async function voteCurrentEntry(direction) {
        const entry = state.entries[state.currentIndex];
        if (!entry) return;
        try {
            const res = await fetch(`/api/entries/${entry.id}/vote`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ direction }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "投票に失敗しました");

            // Keep the same entry focused even if sort order changes
            const focusedId = entry.id;
            state.entries = data.entries || state.entries;
            const idx = state.entries.findIndex((e) => e.id === focusedId);
            state.currentIndex = idx >= 0 ? idx : 0;
            renderViewer();
        } catch (err) {
            showBanner(err.message, true);
        }
    }

    async function deleteCurrentEntry() {
        const entry = state.entries[state.currentIndex];
        if (!entry) return;
        const ok = window.confirm(
            `「${entry.katakana}」（モデル: ${entry.model_name}）のエントリを削除しますか？`
        );
        if (!ok) return;

        try {
            const res = await fetch(`/api/entries/${entry.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "削除に失敗しました");

            state.entries = data.entries || [];
            if (state.currentIndex >= state.entries.length) {
                state.currentIndex = Math.max(0, state.entries.length - 1);
            }
            showBanner("エントリを削除しました。");
            await loadWords(sidebarFilter.value);
            renderViewer();
        } catch (err) {
            showBanner(err.message, true);
        }
    }

    function renderViewer() {
        if (!state.entries || state.entries.length === 0) {
            viewerEl.innerHTML = `
                <div class="empty-state">
                    <p>上の検索ボックスに語を入力するか、左の一覧から語を選んでください。</p>
                </div>
            `;
            return;
        }

        const entry = state.entries[state.currentIndex];
        const total = state.entries.length;
        const scoreText = entry.score > 0 ? `+${entry.score}` : String(entry.score);

        let navHtml = `
            <div class="entry-nav">
                <div class="entry-switcher">
                    <button type="button" id="prev-entry-btn" class="btn btn-secondary btn-sm" ${total <= 1 ? "disabled" : ""}>
                        ◀ 前へ
                    </button>
                    <span class="entry-counter">${state.currentIndex + 1} / ${total}</span>
                    <button type="button" id="next-entry-btn" class="btn btn-secondary btn-sm" ${total <= 1 ? "disabled" : ""}>
                        次へ ▶
                    </button>
                    ${
                        total > 1
                            ? `<div class="dots">${state.entries
                                  .map(
                                      (_, i) =>
                                          `<button type="button" class="dot ${
                                              i === state.currentIndex ? "active" : ""
                                          }" data-dot-index="${i}" aria-label="エントリ ${i + 1}"></button>`
                                  )
                                  .join("")}</div>`
                            : ""
                    }
                </div>
                <button type="button" id="regenerate-btn" class="btn btn-primary btn-sm" ${state.isLoading ? "disabled" : ""}>
                    ＋ 選択モデルで追加生成
                </button>
            </div>
        `;

        let formsHtml = "";
        (entry.written_forms || []).forEach((wf) => {
            const categoryBadge = wf.category
                ? `<span class="badge badge-blue">${escapeHtml(wf.category)}</span>`
                : "";

            let sensesHtml = "";
            (wf.senses || []).forEach((sense, idx) => {
                const posBadge = sense.part_of_speech
                    ? `<span class="badge badge-green">${escapeHtml(sense.part_of_speech)}</span>`
                    : "";

                let examplesHtml = "";
                if (sense.examples && sense.examples.length > 0) {
                    examplesHtml = `
                        <div class="examples-list">
                            ${sense.examples
                                .map(
                                    (ex) =>
                                        `<div class="example">${escapeHtml(ex.sentence)}</div>`
                                )
                                .join("")}
                        </div>
                    `;
                }

                sensesHtml += `
                    <div class="sense">
                        <div class="meaning-row">
                            <strong>${idx + 1}.</strong>
                            ${posBadge}
                            <span class="meaning-text">${escapeHtml(sense.meaning)}</span>
                        </div>
                        ${examplesHtml}
                    </div>
                `;
            });

            formsHtml += `
                <div class="written-form">
                    <div class="word-header">
                        <div class="word-title">${escapeHtml(wf.form)}</div>
                        ${categoryBadge}
                    </div>
                    ${sensesHtml}
                </div>
            `;
        });

        let notesHtml = "";
        if (entry.notes && entry.notes.length > 0) {
            notesHtml = `
                <div class="notes">
                    <div class="section-title">補足</div>
                    <ul>
                        ${entry.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}
                    </ul>
                </div>
            `;
        }

        const cardHtml = `
            ${navHtml}
            <article id="result-card" class="result-card">
                <div class="card-header">
                    <div>
                        <h2 class="katakana-title">${escapeHtml(entry.katakana)}</h2>
                        <div class="entry-meta">
                            <span class="badge badge-blue">Model: ${escapeHtml(entry.model_name)}</span>
                            <span>作成: ${escapeHtml(formatDate(entry.created_at))}</span>
                            ${
                                entry.updated_at && entry.updated_at !== entry.created_at
                                    ? `<span>更新: ${escapeHtml(formatDate(entry.updated_at))}</span>`
                                    : ""
                            }
                        </div>
                    </div>

                    <div class="entry-actions">
                        <div class="vote-group" aria-label="エントリの評価">
                            <button type="button" id="upvote-btn" class="vote-btn" title="良い評価">
                                👍 <span>${entry.upvotes}</span>
                            </button>
                            <span class="vote-score" title="スコア">${escapeHtml(scoreText)}</span>
                            <button type="button" id="downvote-btn" class="vote-btn" title="悪い評価">
                                👎 <span>${entry.downvotes}</span>
                            </button>
                        </div>
                        <button type="button" id="edit-entry-btn" class="btn btn-secondary btn-sm">編集</button>
                        <button type="button" id="delete-entry-btn" class="btn btn-danger btn-sm">削除</button>
                    </div>
                </div>

                <div class="section-title">表記一覧</div>
                ${formsHtml || '<p class="search-hint">表記が登録されていません。</p>'}
                ${notesHtml}
            </article>
            ${
                total > 1
                    ? '<div class="swipe-hint">左右ボタン・キーボード（← / →）・モバイルのスワイプで別エントリを切り替えられます</div>'
                    : ""
            }
        `;

        viewerEl.innerHTML = cardHtml;

        // Wire up viewer events
        document.getElementById("prev-entry-btn")?.addEventListener("click", () => switchEntry(-1));
        document.getElementById("next-entry-btn")?.addEventListener("click", () => switchEntry(1));
        document.getElementById("regenerate-btn")?.addEventListener("click", () => {
            searchOrGenerate(state.currentKatakana, true);
        });
        document.getElementById("upvote-btn")?.addEventListener("click", () => voteCurrentEntry("up"));
        document.getElementById("downvote-btn")?.addEventListener("click", () => voteCurrentEntry("down"));
        document.getElementById("edit-entry-btn")?.addEventListener("click", openEditModal);
        document.getElementById("delete-entry-btn")?.addEventListener("click", deleteCurrentEntry);

        viewerEl.querySelectorAll("[data-dot-index]").forEach((dot) => {
            dot.addEventListener("click", () => {
                jumpToEntry(Number(dot.dataset.dotIndex));
            });
        });

        // Mobile touch swipe support
        const cardEl = document.getElementById("result-card");
        if (cardEl && total > 1) {
            let touchStartX = 0;
            let touchStartY = 0;
            cardEl.addEventListener(
                "touchstart",
                (e) => {
                    if (e.touches.length !== 1) return;
                    touchStartX = e.touches[0].clientX;
                    touchStartY = e.touches[0].clientY;
                },
                { passive: true }
            );
            cardEl.addEventListener(
                "touchend",
                (e) => {
                    if (e.changedTouches.length !== 1) return;
                    const dx = e.changedTouches[0].clientX - touchStartX;
                    const dy = e.changedTouches[0].clientY - touchStartY;
                    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                        switchEntry(dx < 0 ? 1 : -1);
                    }
                },
                { passive: true }
            );
        }
    }

    // Manual Edit Modal
    function createSenseEditor(sense = { part_of_speech: "", meaning: "", examples: [] }) {
        const card = document.createElement("div");
        card.className = "edit-sense-card";

        const top = document.createElement("div");
        top.className = "edit-sense-top";

        const posInput = document.createElement("input");
        posInput.type = "text";
        posInput.className = "edit-pos";
        posInput.placeholder = "品詞（例: 名詞）";
        posInput.value = sense.part_of_speech || "";

        const meaningInput = document.createElement("input");
        meaningInput.type = "text";
        meaningInput.className = "edit-meaning";
        meaningInput.placeholder = "意味の説明";
        meaningInput.required = true;
        meaningInput.value = sense.meaning || "";

        const removeSenseBtn = document.createElement("button");
        removeSenseBtn.type = "button";
        removeSenseBtn.className = "btn btn-danger btn-sm";
        removeSenseBtn.textContent = "意味を削除";
        removeSenseBtn.addEventListener("click", () => card.remove());

        top.appendChild(posInput);
        top.appendChild(meaningInput);
        top.appendChild(removeSenseBtn);

        const examplesInput = document.createElement("textarea");
        examplesInput.className = "edit-examples";
        examplesInput.rows = 2;
        examplesInput.placeholder = "例文（1行につき1つ）";
        examplesInput.value = (sense.examples || [])
            .map((ex) => ex.sentence || "")
            .filter(Boolean)
            .join("\n");

        card.appendChild(top);
        card.appendChild(examplesInput);
        return card;
    }

    function createWrittenFormEditor(wf = { form: "", category: "", senses: [] }) {
        const card = document.createElement("div");
        card.className = "edit-form-card";

        const row = document.createElement("div");
        row.className = "edit-row";

        const formGroup = document.createElement("label");
        formGroup.className = "form-group";
        formGroup.innerHTML = "<span>表記</span>";
        const formInput = document.createElement("input");
        formInput.type = "text";
        formInput.className = "edit-form-name";
        formInput.required = true;
        formInput.value = wf.form || "";
        formGroup.appendChild(formInput);

        const catGroup = document.createElement("label");
        catGroup.className = "form-group";
        catGroup.innerHTML = "<span>分類</span>";
        const catInput = document.createElement("input");
        catInput.type = "text";
        catInput.className = "edit-form-category";
        catInput.placeholder = "一般語・固有名詞など";
        catInput.value = wf.category || "";
        catGroup.appendChild(catInput);

        const removeFormBtn = document.createElement("button");
        removeFormBtn.type = "button";
        removeFormBtn.className = "btn btn-danger btn-sm";
        removeFormBtn.textContent = "表記を削除";
        removeFormBtn.addEventListener("click", () => card.remove());

        row.appendChild(formGroup);
        row.appendChild(catGroup);
        row.appendChild(removeFormBtn);
        card.appendChild(row);

        const sensesContainer = document.createElement("div");
        sensesContainer.className = "edit-senses-container";
        const senses = wf.senses && wf.senses.length > 0 ? wf.senses : [{ part_of_speech: "", meaning: "", examples: [] }];
        senses.forEach((s) => sensesContainer.appendChild(createSenseEditor(s)));
        card.appendChild(sensesContainer);

        const addSenseBtn = document.createElement("button");
        addSenseBtn.type = "button";
        addSenseBtn.className = "btn btn-secondary btn-sm";
        addSenseBtn.textContent = "＋ 意味を追加";
        addSenseBtn.addEventListener("click", () => {
            sensesContainer.appendChild(createSenseEditor());
        });
        card.appendChild(addSenseBtn);

        return card;
    }

    function openEditModal() {
        const entry = state.entries[state.currentIndex];
        if (!entry) return;
        state.editingEntryId = entry.id;
        editKatakanaInput.value = entry.katakana || "";
        editNotesInput.value = (entry.notes || []).join("\n");
        editWrittenFormsEl.innerHTML = "";
        const forms = entry.written_forms && entry.written_forms.length > 0
            ? entry.written_forms
            : [{ form: "", category: "", senses: [] }];
        forms.forEach((wf) => editWrittenFormsEl.appendChild(createWrittenFormEditor(wf)));
        editModal.classList.remove("hidden");
    }

    function closeEditModal() {
        editModal.classList.add("hidden");
        state.editingEntryId = null;
    }

    async function saveEditForm(e) {
        e.preventDefault();
        if (!state.editingEntryId) return;

        const writtenForms = [];
        editWrittenFormsEl.querySelectorAll(".edit-form-card").forEach((formCard) => {
            const form = formCard.querySelector(".edit-form-name").value.trim();
            const category = formCard.querySelector(".edit-form-category").value.trim();
            if (!form) return;

            const senses = [];
            formCard.querySelectorAll(".edit-sense-card").forEach((senseCard) => {
                const partOfSpeech = senseCard.querySelector(".edit-pos").value.trim();
                const meaning = senseCard.querySelector(".edit-meaning").value.trim();
                if (!meaning) return;
                const examples = senseCard
                    .querySelector(".edit-examples")
                    .value.split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((sentence) => ({ sentence }));
                senses.push({
                    part_of_speech: partOfSpeech,
                    meaning,
                    examples,
                });
            });

            writtenForms.push({ form, category, senses });
        });

        const notes = editNotesInput.value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);

        const payload = {
            katakana: editKatakanaInput.value.trim(),
            written_forms: writtenForms,
            notes,
        };

        try {
            const res = await fetch(`/api/entries/${state.editingEntryId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "保存に失敗しました");

            const savedId = state.editingEntryId;
            closeEditModal();
            state.currentKatakana = data.entry.katakana;
            state.entries = data.entries || [];
            const idx = state.entries.findIndex((item) => item.id === savedId);
            state.currentIndex = idx >= 0 ? idx : 0;

            showBanner("エントリを更新しました。");
            await loadWords(sidebarFilter.value);
            renderViewer();
        } catch (err) {
            showBanner(err.message, true);
        }
    }

    // Mobile sidebar helpers
    function openSidebar() {
        sidebar.classList.add("open");
        sidebarBackdrop.classList.remove("hidden");
    }

    function closeSidebar() {
        sidebar.classList.remove("open");
        sidebarBackdrop.classList.add("hidden");
    }

    // Event bindings
    searchForm.addEventListener("submit", (e) => {
        e.preventDefault();
        searchOrGenerate(wordInput.value, false);
    });

    refreshModelsBtn.addEventListener("click", () => {
        const host = ollamaHostInput.value.trim() || defaultHost;
        localStorage.setItem(STORAGE_HOST_KEY, host);
        loadModels(host, modelSelect.value);
    });

    ollamaHostInput.addEventListener("change", () => {
        const host = ollamaHostInput.value.trim() || defaultHost;
        localStorage.setItem(STORAGE_HOST_KEY, host);
        loadModels(host, modelSelect.value);
    });

    modelSelect.addEventListener("change", () => {
        localStorage.setItem(STORAGE_MODEL_KEY, modelSelect.value);
    });

    let filterTimer = null;
    sidebarFilter.addEventListener("input", () => {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(() => loadWords(sidebarFilter.value), 180);
    });

    sidebarToggle.addEventListener("click", openSidebar);
    sidebarBackdrop.addEventListener("click", closeSidebar);

    addFormBtn.addEventListener("click", () => {
        editWrittenFormsEl.appendChild(createWrittenFormEditor());
    });
    editCloseBtn.addEventListener("click", closeEditModal);
    editCancelBtn.addEventListener("click", closeEditModal);
    editForm.addEventListener("submit", saveEditForm);
    editModal.addEventListener("click", (e) => {
        if (e.target === editModal) closeEditModal();
    });

    // Keyboard navigation for multiple entries
    document.addEventListener("keydown", (e) => {
        if (!editModal.classList.contains("hidden")) {
            if (e.key === "Escape") closeEditModal();
            return;
        }
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (e.key === "ArrowLeft") switchEntry(-1);
        if (e.key === "ArrowRight") switchEntry(1);
    });

    // Boot
    initSettings();
    loadWords();
})();
