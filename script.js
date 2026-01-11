document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ---
    const STORAGE_KEY_CONFIG = 'weight_tracker_config';

    // Hardcoded User/Repo (User cannot change these via UI)
    const DEFAULT_CONFIG = {
        username: "pipiz8080-spec",
        repo: "75kg_4",
        token: ""
    };

    const DATA_FILENAME = 'weight_log.csv';
    const YEAR = 2026;
    const MONTH = 0; // January
    const DAYS_IN_MONTH = 31;
    const FIRST_DAY_OF_WEEK = 4; // Jan 1st 2026 is Thu
    const DEFAULT_NAME = "User";

    // --- DOM Elements ---
    const weightInput = document.getElementById('weightInput');
    const saveBtn = document.getElementById('saveBtn');
    const messageEl = document.getElementById('message');
    const loadingEl = document.getElementById('loadingIndicator');
    const calendarGrid = document.getElementById('calendarGrid');
    const startWeightEl = document.getElementById('startWeight');
    const currentWeightEl = document.getElementById('currentWeight');
    const weightChangeEl = document.getElementById('weightChange');

    // Settings DOM
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const ghTokenInput = document.getElementById('ghToken');

    // --- State ---
    let allData = [];
    let filteredData = {};
    let config = loadConfig();
    let fileSha = null;
    let selectedDate = null;

    // --- Initialization ---
    const now = new Date();
    selectedDate = now.getDate();
    if (selectedDate > DAYS_IN_MONTH) selectedDate = DAYS_IN_MONTH;

    function loadConfig() {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_CONFIG)) || {};
        return {
            username: DEFAULT_CONFIG.username,
            repo: DEFAULT_CONFIG.repo,
            token: stored.token || ''
        };
    }

    function saveConfig(newConfig) {
        // Only saving token to storage really matters here
        localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(newConfig));
        config = newConfig;
    }

    // --- CSV Helpers ---

    function parseCSV(csvText) {
        const lines = csvText.split('\n').filter(line => line.trim() !== '');
        const data = [];
        let startI = 0;
        if (lines[0] && lines[0].toLowerCase().includes('date')) {
            startI = 1;
        }

        for (let i = startI; i < lines.length; i++) {
            const parts = lines[i].split(',');
            if (parts.length >= 3) {
                data.push({
                    date: parts[0].trim(),
                    name: parts[1].trim(),
                    weight: parseFloat(parts[2].trim())
                });
            }
        }
        return data;
    }

    function dataToCSV(dataArray) {
        dataArray.sort((a, b) => a.date.localeCompare(b.date));
        let csv = 'Date,Name,Weight\n';
        dataArray.forEach(row => {
            csv += `${row.date},${row.name},${row.weight}\n`;
        });
        return csv;
    }

    function filterDataForUser() {
        filteredData = {};
        allData.forEach(row => {
            if (row.name === DEFAULT_NAME) {
                const parts = row.date.split('-');
                if (parts.length === 3) {
                    const y = parseInt(parts[0]);
                    const m = parseInt(parts[1]) - 1;
                    const d = parseInt(parts[2]);

                    if (y === YEAR && m === MONTH) {
                        filteredData[d] = row.weight;
                    }
                }
            }
        });
    }

    // --- GitHub API Functions ---

    function getHeaders() {
        return {
            'Authorization': `token ${config.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
        };
    }

    async function fetchFromGitHub(silent = false) {
        if (!config.token) {
            if (!silent) openSettingsModal();
            return false;
        }

        if (!silent) setLoading(true);
        const url = `https://api.github.com/repos/${config.username}/${config.repo}/contents/${DATA_FILENAME}`;

        try {
            const response = await fetch(url, {
                headers: getHeaders(),
                cache: 'no-store'
            });

            if (response.status === 404) {
                allData = [];
                fileSha = null;
                console.log('No data file found, starting fresh.');
            } else if (response.ok) {
                const data = await response.json();
                fileSha = data.sha;
                const content = decodeURIComponent(escape(window.atob(data.content)));
                allData = parseCSV(content);
            } else {
                throw new Error(`GitHub Error: ${response.status}`);
            }

            filterDataForUser();
            updateUI();
            return true;

        } catch (error) {
            console.error(error);
            if (!silent) showMessage('同步失敗: ' + error.message, 'error');
            return false;
        } finally {
            if (!silent) setLoading(false);
        }
    }

    async function saveToGitHub(retryCount = 0) {
        if (!config.token) {
            openSettingsModal();
            showMessage('請設定 GitHub Token', 'error');
            return;
        }

        setLoading(true);
        const url = `https://api.github.com/repos/${config.username}/${config.repo}/contents/${DATA_FILENAME}`;

        const contentStr = dataToCSV(allData);
        const contentBase64 = window.btoa(unescape(encodeURIComponent(contentStr)));

        const payload = {
            message: `Update ${DEFAULT_NAME} - ${new Date().toISOString()}`,
            content: contentBase64,
            ...(fileSha ? { sha: fileSha } : {})
        };

        try {
            const response = await fetch(url, {
                method: 'PUT',
                headers: getHeaders(),
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const data = await response.json();
                fileSha = data.content.sha;
                showMessage(`上傳成功!`, 'success');
            } else if (response.status === 409 && retryCount < 2) {
                console.warn('Conflict detected, retrying...', retryCount);
                showMessage('同步衝突，重試中...', 'error');
                const success = await fetchFromGitHub(true);
                if (success) {
                    reapplyCurrentInput();
                    await saveToGitHub(retryCount + 1);
                }
            } else {
                const errData = await response.json();
                throw new Error(errData.message || 'Save failed');
            }
        } catch (error) {
            console.error(error);
            showMessage('上傳失敗: ' + error.message, 'error');
        } finally {
            setLoading(false);
        }
    }

    function reapplyCurrentInput() {
        if (!selectedDate) return;
        const val = parseFloat(weightInput.value);
        if (isNaN(val) || val <= 0) return;

        const dateStr = `${YEAR}-${String(MONTH + 1).padStart(2, '0')}-${String(selectedDate).padStart(2, '0')}`;

        const foundIndex = allData.findIndex(row => row.date === dateStr && row.name === DEFAULT_NAME);
        if (foundIndex >= 0) {
            allData[foundIndex].weight = val;
        } else {
            allData.push({ date: dateStr, name: DEFAULT_NAME, weight: val });
        }
        filterDataForUser();
    }

    // --- UI Functions ---

    function updateUI() {
        updateStats();
        renderCalendar();
        if (selectedDate && filteredData[selectedDate]) {
            weightInput.value = filteredData[selectedDate];
        } else {
            weightInput.value = '';
        }
    }

    function handleSave() {
        const val = parseFloat(weightInput.value);

        if (isNaN(val) || val <= 0 || val > 300) {
            showMessage('請輸入有效體重', 'error');
            return;
        }

        if (!selectedDate) selectedDate = 1;

        reapplyCurrentInput();
        updateUI();
        saveToGitHub();
    }

    function showMessage(msg, type) {
        messageEl.textContent = msg;
        messageEl.className = `message ${type}`;
        if (type === 'success') {
            setTimeout(() => {
                messageEl.textContent = '';
                messageEl.className = 'message';
            }, 3000);
        }
    }

    function setLoading(isLoading) {
        if (isLoading) {
            loadingEl.classList.remove('hidden');
            saveBtn.disabled = true;
        } else {
            loadingEl.classList.add('hidden');
            saveBtn.disabled = false;
        }
    }

    function updateStats() {
        const days = Object.keys(filteredData).map(Number).sort((a, b) => a - b);

        if (days.length === 0) {
            startWeightEl.textContent = '--';
            currentWeightEl.textContent = '--';
            weightChangeEl.textContent = '--';
            weightChangeEl.className = 'neutral';
            return;
        }

        const firstWeight = filteredData[days[0]];
        const lastWeight = filteredData[days[days.length - 1]];

        startWeightEl.textContent = firstWeight.toFixed(1);
        currentWeightEl.textContent = lastWeight.toFixed(1);

        const change = lastWeight - firstWeight;
        const sign = change > 0 ? '+' : '';
        weightChangeEl.textContent = `${sign}${change.toFixed(1)} kg`;

        if (change > 0) {
            weightChangeEl.className = 'positive';
        } else if (change < 0) {
            weightChangeEl.className = 'negative';
        } else {
            weightChangeEl.className = 'neutral';
        }
    }

    function renderCalendar() {
        calendarGrid.innerHTML = '';
        for (let i = 0; i < FIRST_DAY_OF_WEEK; i++) {
            const emptyCell = document.createElement('div');
            emptyCell.className = 'day-cell empty';
            calendarGrid.appendChild(emptyCell);
        }
        for (let d = 1; d <= DAYS_IN_MONTH; d++) {
            const cell = document.createElement('div');
            cell.className = 'day-cell';
            const dateNum = document.createElement('div');
            dateNum.className = 'date-num';
            dateNum.textContent = d;
            const weightVal = document.createElement('div');
            weightVal.className = 'weight-val';

            if (filteredData[d]) {
                cell.classList.add('has-data');
                weightVal.textContent = filteredData[d];
            } else {
                weightVal.textContent = '-';
            }
            cell.appendChild(dateNum);
            cell.appendChild(weightVal);
            cell.addEventListener('click', () => {
                selectDate(d);
            });
            if (d === selectedDate) {
                cell.classList.add('today');
            }
            calendarGrid.appendChild(cell);
        }
    }

    function selectDate(day) {
        selectedDate = day;
        renderCalendar();
        if (filteredData[day]) {
            weightInput.value = filteredData[day];
        } else {
            weightInput.value = '';
        }
    }

    // --- Settings UI Logic ---
    function openSettingsModal() {
        ghTokenInput.value = config.token || '';
        settingsModal.classList.remove('hidden');
    }

    function handleSettingsSave() {
        const token = ghTokenInput.value.trim();

        if (!token) {
            alert('請填寫 Token');
            return;
        }

        saveConfig({
            username: DEFAULT_CONFIG.username,
            repo: DEFAULT_CONFIG.repo,
            token: token
        });

        settingsModal.classList.add('hidden');

        // Reload data
        allData = [];
        fileSha = null;
        fetchFromGitHub();
    }

    // --- Init ---
    saveBtn.addEventListener('click', handleSave);
    weightInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSave();
    });

    settingsBtn.addEventListener('click', openSettingsModal);
    closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));
    saveSettingsBtn.addEventListener('click', handleSettingsSave);

    if (config.token) {
        fetchFromGitHub();
    } else {
        openSettingsModal();
    }

    if (selectedDate) selectDate(selectedDate);
    renderCalendar();
    updateStats();
});
