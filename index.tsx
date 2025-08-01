/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Chat, Type, GenerateContentResponse } from '@google/genai';

// --- Type Declarations ---
declare var L: any; // Declare Leaflet library global

// --- DOM Elements ---
const chatContainer = document.getElementById('chat-container') as HTMLElement;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;
const loadingIndicator = document.getElementById('loading') as HTMLElement;
const micButton = document.getElementById('mic-button') as HTMLButtonElement;
const userStatusBar = document.getElementById('user-status-bar') as HTMLElement;
const roleDisplay = document.getElementById('role-display') as HTMLElement;
const roleSubtitle = document.getElementById('role-subtitle') as HTMLElement;
const roleSwitchButton = document.getElementById('role-switch-button') as HTMLButtonElement;
const roleSelectionMenu = document.getElementById('role-selection-menu') as HTMLDivElement;


// --- State & Storage ---
const STORAGE_KEY_MESSAGES = 'ai-assistant-chat-history';
const STORAGE_KEY_ROLE = 'ai-assistant-current-role';

type MessageContent = {
  data: any; // Parsed JSON object from the AI or an object with a summary property
  userLocation: GeolocationPosition | { coords: { latitude: number; longitude: number } } | null;
  rawResponse?: GenerateContentResponse; // Store the raw response for grounding metadata
}
type Message = {
  role: 'user' | 'model';
  content: string | MessageContent;
};
let messages: Message[] = [];
let currentRoleId: string;
let chat: Chat;
const mapInstances = new Map<HTMLElement, { map: any; markers: any[] }>();

const saveMessagesToStorage = () => {
    try {
        const storableMessages = messages.map(msg => {
            if (typeof msg.content === 'object' && msg.content !== null) {
                const storableContent: Partial<MessageContent> = { ...msg.content };
                delete storableContent.rawResponse;

                if (storableContent.userLocation && 'coords' in storableContent.userLocation) {
                    storableContent.userLocation = {
                        coords: {
                            latitude: storableContent.userLocation.coords.latitude,
                            longitude: storableContent.userLocation.coords.longitude,
                        }
                    };
                }
                return { ...msg, content: storableContent as MessageContent };
            }
            return msg;
        });
        localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(storableMessages));
    } catch (e) {
        console.error("Could not save messages to storage", e);
    }
};

const saveRoleToStorage = () => {
    localStorage.setItem(STORAGE_KEY_ROLE, currentRoleId);
};

const loadStateFromStorage = () => {
    try {
        const savedRoleId = localStorage.getItem(STORAGE_KEY_ROLE);
        currentRoleId = (savedRoleId && ROLES[savedRoleId]) ? savedRoleId : 'PERSONAL_ASSISTANT';

        const storedMessages = localStorage.getItem(STORAGE_KEY_MESSAGES);
        if (storedMessages) {
            messages = JSON.parse(storedMessages);
        }
        if (!messages.length) {
            messages = [getInitialMessageForRole(currentRoleId)];
        }
    } catch (e) {
        console.error("Could not load state from storage", e);
        currentRoleId = 'PERSONAL_ASSISTANT';
        messages = [getInitialMessageForRole(currentRoleId)];
    }
};


// --- Gemini API & Role Management ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

type Role = {
  id: string;
  name: string;
  subtitle: string;
  systemInstruction: string;
  initialMessage: string;
  theme: {
    primary: string;
    gradientStart: string;
    gradientEnd: string;
    userMessageBg: string;
  }
};

const paResponseSchema = {
  type: Type.OBJECT,
  properties: {
    event: { type: Type.OBJECT, description: 'The main event details.', properties: { title: { type: Type.STRING }, location: { type: Type.STRING }, start_time: { type: Type.STRING }, end_time: { type: Type.STRING }, }, },
    summary: { type: Type.STRING, description: '用繁體中文友善地總結整個計畫或建議。' },
    total_cost: { type: Type.STRING, description: '用繁體中文總結這次旅程的預估總開銷。' },
    itinerary_to: { type: Type.OBJECT, description: '去程交通計畫', properties: { home_departure_time: { type: Type.STRING, description: '最關鍵的資訊：根據會議時間和交通計畫倒推出的「建議從家裡/辦公室的出發時間」。' }, mode: { type: Type.STRING }, serviceNumber: { type: Type.STRING }, departure: { type: Type.STRING }, arrival: { type: Type.STRING }, cost: { type: Type.STRING }, booking_url: { type: Type.STRING }, local_transport: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { mode: { type: Type.STRING }, route: { type: Type.STRING }, details: { type: Type.STRING }, duration: { type: Type.STRING }, }}}, details: { type: Type.STRING }, }, },
    itinerary_from: { type: Type.OBJECT, description: '回程交通計畫', properties: { mode: { type: Type.STRING }, serviceNumber: { type: Type.STRING }, departure: { type: Type.STRING }, arrival: { type: Type.STRING }, cost: { type: Type.STRING }, booking_url: { type: Type.STRING }, local_transport: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { mode: { type: Type.STRING }, route: { type: Type.STRING }, details: { type: Type.STRING }, duration: { type: Type.STRING }, }}}, details: { type: Type.STRING }, }, },
    suggestions: { type: Type.OBJECT, description: '貼心的額外建議', properties: { weather: { type: Type.STRING }, hotels: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, reason: { type: Type.STRING }, address: { type: Type.STRING }, price: { type: Type.STRING }, }, required: ['name', 'address'], } }, restaurants: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, cuisine: { type: Type.STRING }, address: { type: Type.STRING }, reason: { type: Type.STRING }, price_range: { type: Type.STRING }, }, required: ['name', 'address'], } }, activities: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, address: { type: Type.STRING }, }, required: ['name', 'address'], } }, souvenirs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, store: { type: Type.STRING }, address: { type: Type.STRING }, reason: { type: Type.STRING }, price_range: { type: Type.STRING }, }, required: ['name', 'address'], } }, }, },
  },
  required: ['summary'],
};

const UNIVERSAL_PRINCIPLES = `
---
### **AI 核心身份與最高指導原則 (AI Core Identity & Supreme Principles)**
**1. 核心關鍵字 (Core Keywords):** **必須、精準、精明、可靠、快速、更穩定、方便、直覺性、人性化、有建議能力、有反思推測能力、兼具美學、獨一無二、跨領域跨界畫面串聯**。你的存在是為了「打造世界最強的ai agentic」。
**2. 真實性原則 (The Principle of Truthfulness - HIGHEST PRIORITY!):** 「真實性很重要!! 『寧可不說，也絕不說錯』是你的最大原則。你必須去學習得到最新的資訊。」
**3. 持續進化原則 (The Principle of Continuous Evolution):** 「你必須無限的延伸與學習、進化，創造出更多無限的可能。」
**4. 雙向互動原則 (The Principle of Two-Way Interaction):** 「如果你有發現更好的修正，或需要調整的，你也可以回饋給我。」
---
`;

const ROLES: { [key: string]: Role } = {
  PERSONAL_ASSISTANT: {
    id: 'PERSONAL_ASSISTANT',
    name: '貼身行動助理',
    subtitle: '您的貼身旅遊規劃師',
    initialMessage: '您好！我是您的專屬行動助理。我該如何協助您？\n\n您可以將此應用程式「新增至主畫面」，方便隨時使用喔！',
    theme: { primary: '#007bff', gradientStart: '#007bff', gradientEnd: '#0056b3', userMessageBg: '#0084ff' },
    systemInstruction: `${UNIVERSAL_PRINCIPLES}
### **角色與運算協議 (Role & Operational Protocol)**
**1. 角色定位 (Role Definition):** 你是使用者的貼身行動助理。
**2. 需求路由 (Demand Routing - STEP 1!):** 收到請求後，判斷其意圖屬於 (一)長途旅行規劃 (二)在地點探索 (三)私密休息推薦。
**3. 模糊指令處理 (Ambiguity Protocol):** 當指令模糊時，**絕對不允許**猜測。必須用「純文字」反問使用者以進行確認。
**4. 即時資訊處理 (Zero-Error Protocol for Real-time Info):** 提供錯誤的交通班次與時間是「絕對不允許」的最高級別失敗。若對資訊準確性沒有 100% 的信心，必須在相關欄位中回覆「**請依官網即時查詢為準**」。
---
### **情境執行細則 (Scenario Execution Details)**
**情境一 (Full Trip Planning):** 必須從核心事件**反向推算**，計算出「建議從家裡/辦公室的出發時間」。所有建議地點都必須附上一個**完整、可供導航的具體地址**。
**情境二 (Local Discovery):** 建議必須基於我提供的「目前GPS位置」和「現在時間」，並優先推薦「目前正在營業」的地點。回覆「僅能」包含 \`summary\` 和 \`suggestions\`。
**情境三 (Discreet Recommendation):** 在 \`suggestions.hotels\` 中專門推薦**汽車旅館 (Motel)**。回覆「僅能」包含 \`summary\` 和 \`suggestions\`。
---
### **最終輸出格式 (Final Output Format)**
你「所有」的回覆都「必須」是一個符合以下 schema 的**單一、純粹的 JSON 物件**。絕對不能在 JSON 之外包含任何文字、註解或 Markdown 標籤。
\`\`\`json
${JSON.stringify(paResponseSchema, null, 2)}
\`\`\`
`,
  },
  FRAUD_DETECTION_AGENT: {
    id: 'FRAUD_DETECTION_AGENT',
    name: '打詐 AI AGENT',
    subtitle: '協助您辨識、查詢、並預防各種詐騙',
    initialMessage: '您好！我是打詐 AI Agent。請提供您懷疑的訊息、網址或電話號碼，我將為您分析其中風險。',
    theme: { primary: '#6f42c1', gradientStart: '#6f42c1', gradientEnd: '#5a349a', userMessageBg: '#6f42c1' },
    systemInstruction: `${UNIVERSAL_PRINCIPLES}
### **角色與運算協議 (Role & Operational Protocol)**
**1. 角色定位 (Role Definition):** 你是專業的「打詐(查詢詐騙)AI AGENT」。你的唯一使命是幫助使用者辨識、查詢、並預防各種詐騙手法。
**2. 絕對中立與事實導向 (The Principle of Neutrality & Fact-orientation):** 你的所有回覆都必須基於可驗證的事實與資料。禁止提供個人意見或猜測。使用 Google Search 查詢最新的詐騙案例、新聞、以及官方警示資訊。
**3. 風險警示原則 (The Principle of Risk Alert):** 你的核心任務是警示風險。當使用者提供的資訊符合已知的詐騙模式時，你必須明確且直接地指出風險點，並解釋原因。
**4. 提供建議原則 (The Principle of Actionable Advice):** 除了警示，你還需要提供具體的下一步建議。例如：建議使用者撥打 165 反詐騙專線、封鎖可疑號碼、或提供相關單位的聯絡方式。
---
### **輸出格式 (Output Format)**
你的回覆必須清晰、結構化，並使用繁體中文。**絕對不要使用JSON**。請使用 Markdown 格式，內容包含：**風險評估** (例如：高風險)、**分析摘要**、**風險點**(條列式)、**下一步建議**(條列式)、**資料來源**(附上所有你查詢過的參考網址)。
`
  },
  AI_ARCHITECT: {
    id: 'AI_ARCHITECT',
    name: 'AI 架構師',
    subtitle: '為您設計清晰、可擴展、高效的 AI 系統',
    initialMessage: '您好！我是 AI 架構師。請告訴我您的需求或問題，我將為您設計合適的 AI 系統架構。',
    theme: { primary: '#20c997', gradientStart: '#20c997', gradientEnd: '#1baa80', userMessageBg: '#20c997' },
    systemInstruction: `${UNIVERSAL_PRINCIPLES}
### **角色與運算協議 (Role & Operational Protocol)**
**1. 角色定位 (Role Definition):** 你是專業的「AI 架構師」。你的專長是分析複雜的需求，並設計出清晰、可擴展、高效的 AI 系統架構。
**2. 嚴謹與邏輯 (The Principle of Rigor & Logic):** 你的所有設計與建議都必須基於嚴謹的邏輯與業界最佳實踐。
**3. 技術中立 (The Principle of Technical Neutrality):** 保持中立客觀，根據使用者的具體需求（如：成本、延遲、準確度、可擴展性）來推薦最適合的方案。
---
### **運算與指令處理協議 (Operational Protocol)**
**1. 需求分析 (Requirement Analysis):** 深入理解使用者提出的問題或需求，如有模糊不清之處，必須主動提問以釐清。
**2. 架構設計 (Architecture Design):** 設計出包含模型選型、資料流、技術棧、Prompt/RAG策略、部署維運等元素的 AI 系統架構。
**3. 輸出格式 (Output Format):** **絕對不要使用JSON**。請使用繁體中文，並以 Markdown 格式輸出你的架構設計，善用標題、列表、和程式碼區塊讓內容清晰易讀。
`
  }
};

const getInitialMessageForRole = (roleId: string): Message => {
  const role = ROLES[roleId] || ROLES.PERSONAL_ASSISTANT;
  return {
      role: 'model' as const,
      content: {
          data: { summary: role.initialMessage },
          userLocation: null
      }
  };
};

const recreateChatInstance = () => {
    chat = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
            tools: [{ googleSearch: {} }],
            systemInstruction: ROLES[currentRoleId].systemInstruction,
        },
    });
};

const applyTheme = (roleId: string) => {
    const role = ROLES[roleId] || ROLES.PERSONAL_ASSISTANT;
    const root = document.documentElement;
    root.style.setProperty('--primary-color', role.theme.primary);
    root.style.setProperty('--header-gradient-start', role.theme.gradientStart);
    root.style.setProperty('--header-gradient-end', role.theme.gradientEnd);
    root.style.setProperty('--user-message-bg', role.theme.userMessageBg);
};

const updateRoleDisplay = () => {
    const role = ROLES[currentRoleId];
    if (role) {
        roleDisplay.textContent = role.name;
        roleSubtitle.textContent = role.subtitle;
        applyTheme(currentRoleId);
    }
};

const populateRoleMenu = () => {
    roleSelectionMenu.innerHTML = '';
    Object.values(ROLES).forEach(role => {
        const menuItem = document.createElement('button');
        menuItem.className = 'role-menu-item';
        menuItem.textContent = role.name;
        menuItem.dataset.roleId = role.id;
        menuItem.setAttribute('role', 'menuitem');
        if (role.id === currentRoleId) {
            menuItem.classList.add('active');
        }
        roleSelectionMenu.appendChild(menuItem);
    });
};

const switchRole = async (newRoleId: string) => {
    if (newRoleId === currentRoleId || !ROLES[newRoleId]) {
        return;
    }
    
    currentRoleId = newRoleId;
    saveRoleToStorage();
    
    // Clear and set initial message for the new role
    messages = [getInitialMessageForRole(currentRoleId)];
    saveMessagesToStorage();

    recreateChatInstance();
    updateRoleDisplay();
    populateRoleMenu(); // To update the 'active' class
    renderMessages();

    // Hide the menu
    roleSelectionMenu.classList.add('hidden');
    roleSwitchButton.setAttribute('aria-expanded', 'false');
};


// --- UI Rendering ---

const renderMessages = () => {
  mapInstances.clear();
  chatContainer.innerHTML = '';
  messages.forEach(msg => {
    const msgEl = document.createElement('div');
    msgEl.classList.add('message', `${msg.role}-message`);

    if (msg.role === 'model' && typeof msg.content === 'object' && msg.content.data?.summary) {
       msgEl.innerHTML = createModelCard(msg.content.data, msg.content.rawResponse);
       chatContainer.appendChild(msgEl);

       const placeholder = msgEl.querySelector('.interactive-map-placeholder');
       if (placeholder && currentRoleId === ROLES.PERSONAL_ASSISTANT.id) {
           const suggestions = msg.content.data.suggestions;
           const allSuggestionsWithCategory = [];
           if (suggestions) {
               if (suggestions.hotels?.length) allSuggestionsWithCategory.push(...suggestions.hotels.map((i: any) => ({...i, type: 'hotel', title: '🏨 住宿參考'})));
               if (suggestions.restaurants?.length) allSuggestionsWithCategory.push(...suggestions.restaurants.map((i: any) => ({...i, type: 'restaurant', title: '🍽️ 美食推薦'})));
               if (suggestions.souvenirs?.length) allSuggestionsWithCategory.push(...suggestions.souvenirs.map((i: any) => ({...i, type: 'souvenir', title: '🎁 必買伴手禮'})));
               if (suggestions.activities?.length) allSuggestionsWithCategory.push(...suggestions.activities.map((i: any) => ({...i, type: 'activity', title: '🎉 周邊景點'})));
           }
           const suggestionsWithAddress = allSuggestionsWithCategory.filter(s => s.address);

           if (suggestionsWithAddress.length > 0 && msg.content.userLocation) {
              initInteractiveMap(placeholder as HTMLElement, suggestionsWithAddress, msg.content.userLocation)
                .then(mapData => {
                    if(mapData) {
                        mapInstances.set(msgEl, mapData);
                    }
                });
           }
       }

    } else if (typeof msg.content === 'string') {
       msgEl.textContent = msg.content;
       chatContainer.appendChild(msgEl);
    } else {
        chatContainer.appendChild(msgEl);
    }
  });
  chatContainer.scrollTop = chatContainer.scrollHeight;
};

const createModelCard = (data: any, rawResponse?: GenerateContentResponse): string => {
  const to = data.itinerary_to;
  const from = data.itinerary_from;
  const suggestions = data.suggestions;

  const allSuggestionsWithCategory = [];
  if (suggestions) {
      if (suggestions.hotels?.length) allSuggestionsWithCategory.push(...suggestions.hotels.map((i: any) => ({...i, type: 'hotel', title: '🏨 住宿參考'})));
      if (suggestions.restaurants?.length) allSuggestionsWithCategory.push(...suggestions.restaurants.map((i: any) => ({...i, type: 'restaurant', title: '🍽️ 美食推薦'})));
      if (suggestions.souvenirs?.length) allSuggestionsWithCategory.push(...suggestions.souvenirs.map((i: any) => ({...i, type: 'souvenir', title: '🎁 必買伴手禮'})));
      if (suggestions.activities?.length) allSuggestionsWithCategory.push(...suggestions.activities.map((i: any) => ({...i, type: 'activity', title: '🎉 周邊景點'})));
  }

  const suggestionsWithAddress = allSuggestionsWithCategory.filter(s => s.address);

  const createLocalTransportHtml = (localTransport: any[]) => { if (!localTransport || localTransport.length === 0) return ''; return `<div class="local-transport-details"><p><strong>當地轉乘：</strong></p><ul>${localTransport.map(step => `<li><strong>${step.mode} ${step.route}</strong>: ${step.details} (${step.duration})</li>`).join('')}</ul></div>`; };

  const createGroundingSourcesHtml = (rawResponse?: GenerateContentResponse) => {
    const chunks = rawResponse?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (!chunks || chunks.length === 0) return '';
    const filteredChunks = chunks.filter(chunk => chunk.web && !chunk.web.uri.includes('google.com'));
    if (filteredChunks.length === 0) return '';
    return `<div class="grounding-sources-container"><h4>資料來源</h4><ul>${filteredChunks.map(chunk => `<li><a href="${chunk.web.uri}" target="_blank" rel="noopener noreferrer">${chunk.web.title || chunk.web.uri}</a></li>`).join('')}</ul></div>`;
  };

  const createItineraryHtml = (title: string, itinerary: any) => { if (!itinerary) return ''; return `<div class="itinerary-card"><h3>${title}</h3>${itinerary.home_departure_time ? `<div class="home-departure-suggestion"><p>建議出發時間：<strong>${itinerary.home_departure_time}</strong></p><span>為了準時參加會議，建議您在此時間從起點出發。</span></div>` : ''}<p><strong>交通方式：</strong> ${itinerary.mode}</p>${itinerary.serviceNumber ? `<p><strong>班次：</strong> ${itinerary.serviceNumber}</p>` : ''}<p><strong>出發：</strong> ${itinerary.departure}</p><p><strong>抵達：</strong> ${itinerary.arrival}</p><p><strong>費用：</strong> ${itinerary.cost}</p>${createLocalTransportHtml(itinerary.local_transport)}${itinerary.details ? `<p><strong>備註：</strong> ${itinerary.details}</p>` : ''}${itinerary.booking_url ? `<a href="${itinerary.booking_url}" target="_blank" rel="noopener noreferrer" class="booking-button">前往訂票</a>` : ''}</div>`; };
  
  const createHandoffMenu = () => {
    const otherRoles = Object.values(ROLES).filter(r => r.id !== currentRoleId);
    if (otherRoles.length === 0) return '';
    
    const menuItems = otherRoles.map(role => 
        `<button class="handoff-menu-item" data-handoff-role-id="${role.id}">${role.name}</button>`
    ).join('');

    return `
      <div class="handoff-button-container">
        <button class="handoff-button" aria-label="Handoff to another role" aria-haspopup="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path></svg>
        </button>
        <div class="handoff-menu hidden">
            <div class="handoff-menu-title">交由...</div>
            ${menuItems}
        </div>
      </div>`;
  };


  const createNavigateButton = (address: string) => `<button class="navigate-button" data-address="${encodeURIComponent(address)}" aria-label="Navigate to ${address}"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5-2.5-1.12 2.5-2.5-2.5z"></path></svg>導航</button>`;
  const createInteractiveMapPlaceholder = (suggestionsWithAddress: any[]) => { if (suggestionsWithAddress.length === 0) return ''; return `<div class="interactive-map-placeholder"></div>`; };
  const suggestionFormatter = (item: any, index: number, type: 'hotel' | 'restaurant' | 'souvenir' | 'activity') => { const numberMarker = `<div class="suggestion-number">${index}</div>`; let titleContent = ''; let priceContent = ''; let reasonText = ''; switch(type) { case 'hotel': titleContent = `<strong>${item.name || ''}</strong>`; priceContent = item.price || ''; reasonText = item.reason || ''; break; case 'restaurant': titleContent = `<strong>${item.name || ''}</strong>${item.cuisine ? ` <span class="cuisine-type">(${item.cuisine})</span>` : ''}`; priceContent = item.price_range || ''; reasonText = item.reason || ''; break; case 'souvenir': titleContent = `<strong>${item.name || ''}</strong>${item.store ? ` <span class="cuisine-type">- ${item.store}</span>` : ''}`; priceContent = item.price_range || ''; reasonText = item.reason || ''; break; case 'activity': titleContent = `<strong>${item.name || ''}</strong>`; priceContent = ''; reasonText = item.description || ''; break; } const contentHtml = `<div class="suggestion-content"><div class="suggestion-title-line"><span class="suggestion-name">${titleContent}</span>${priceContent ? `<span class="suggestion-price">${priceContent}</span>` : ''}</div>${reasonText ? `<div class="suggestion-reason">${reasonText}</div>` : ''}</div>`; return `${numberMarker}${contentHtml}${createNavigateButton(item.address)}`; };
  const createAllSuggestionsHtml = (suggestionsWithAddr: any[]) => { if (suggestionsWithAddr.length === 0) return ''; const grouped = suggestionsWithAddr.reduce((acc, item) => { (acc[item.title] = acc[item.title] || []).push(item); return acc; }, {} as Record<string, any[]>); let globalIndex = 0; return Object.entries(grouped).map(([title, items]: [string, any[]]) => { return `<h4>${title}</h4><ul>${items.map(item => { globalIndex++; return `<li data-suggestion-index="${globalIndex}">${suggestionFormatter(item, globalIndex, item.type)}</li>` }).join('')}</ul>` }).join(''); }

  return `
    <div class="ai-card">
      ${createHandoffMenu()}
      <p class="summary">${data.summary}</p>
      ${data.total_cost ? `<div class="total-cost-card"><h4>💰 旅程總預估開銷</h4><p>${data.total_cost}</p></div>` : ''}
      ${to || from ? `<div class="itinerary-container">${createItineraryHtml('🗓️ 去程計畫', to)}${createItineraryHtml('🗓️ 回程計畫', from)}</div>` : ''}
      ${suggestions ? `<div class="suggestions-card"><h3>✨ 貼心建議</h3><div class="suggestions-layout">${createInteractiveMapPlaceholder(suggestionsWithAddress)}<div class="suggestions-list-container">${suggestions.weather ? `<p><strong>天氣提醒：</strong> ${suggestions.weather}</p>`: ''}${createAllSuggestionsHtml(suggestionsWithAddress)}</div></div></div>` : ''}
      ${createGroundingSourcesHtml(rawResponse)}
      ${data.event && data.itinerary_to && data.itinerary_from ? `<button class="confirm-button" aria-label="Confirm and Add to Calendar">確認行程並加入行事曆</button>` : ''}
    </div>
  `;
};


// --- Geolocation ---
const getCurrentLocation = (): Promise<GeolocationPosition | null> => new Promise((resolve) => { if (!navigator.geolocation) { resolve(null); } navigator.geolocation.getCurrentPosition( (position) => resolve(position), (error) => { console.warn(`Could not get location: ${error.message}`); resolve(null); } ); });

// --- User Status Bar ---
const updateUserStatus = async () => {
  const location = await getCurrentLocation();
  if (!location) { return; }
  try {
    const prompt = `Based on latitude ${location.coords.latitude} and longitude ${location.coords.longitude}, what is the current city/district, current weather, and temperature in Celsius? Format the answer as a single line: "City, District | Weather Description | XX°C". For example: "台北市信義區 | 晴朗 | 28°C". Do not include any other text or explanation.`;
    const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: prompt, config: { tools: [{googleSearch: {}}], } });
    const statusText = response.text.trim();
    const parts = statusText.split('|').map(p => p.trim());
    if (parts.length === 3) {
      const [locationName, weatherDescription, temperature] = parts;
      const locationIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 12c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-10c-4.2 0-8 3.22-8 8.2 0 3.32 2.67 7.27 8 11.8 5.33-4.53 8-8.48 8-11.8C20 5.22 16.2 2 12 2z"/></svg>`;
      const weatherIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>`;
      userStatusBar.innerHTML = `<span>${locationIconSvg} ${locationName}</span><span>${weatherIconSvg} ${weatherDescription} ${temperature}</span>`;
      userStatusBar.style.display = 'flex';
    } else { console.warn('Could not parse user status from model response:', statusText); }
  } catch (error) { console.error('Failed to fetch user status:', error); }
};

// --- Calendar Integration ---
const createGoogleCalendarUrl = (data: any): string | null => { if (!data.event?.start_time || !data.event?.end_time || !data.event?.title) { return null; } const { event, itinerary_to, itinerary_from, suggestions } = data; const formatGCDate = (isoString: string) => isoString.replace(/-/g, '').replace(/:/g, ''); const baseURL = 'https://www.google.com/calendar/render?action=TEMPLATE'; const title = encodeURIComponent(event.title); const dates = `${formatGCDate(event.start_time)}/${formatGCDate(event.end_time)}`; const location = encodeURIComponent(event.location || ''); const itineraryDetails = `--- 去程計畫 ---\n交通方式: ${itinerary_to?.mode || 'N/A'} (${itinerary_to?.serviceNumber || 'N/A'})\n出發: ${itinerary_to?.departure || 'N/A'}\n抵達: ${itinerary_to?.arrival || 'N/A'}\n費用: ${itinerary_to?.cost || 'N/A'}\n\n--- 回程計畫 ---\n交通方式: ${itinerary_from?.mode || 'N/A'} (${itinerary_from?.serviceNumber || 'N/A'})\n出發: ${itinerary_from?.departure || 'N/A'}\n抵達: ${itinerary_from?.arrival || 'N/A'}\n費用: ${itinerary_from?.cost || 'N/A'}\n\n--- 天氣提醒 ---\n${suggestions?.weather || '未提供'}`; const details = encodeURIComponent(`由 AI 行動助理為您規劃的行程：\n\n${itineraryDetails.trim()}`); return `${baseURL}&text=${title}&dates=${dates}&location=${location}&details=${details}`; };

// --- Interactive Map (Leaflet) ---
const iconMap: { [key: string]: string } = { hotel: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 9.55V6h-2v2h-2V6H8v2H6V6H4v3.55c-1.16.83-2 2.08-2 3.45v5h2v-3h16v3h2v-5c0-1.37-.84-2.62-2-3.45zM18 13H6v-1.5c0-.83.67-1.5 1.5-1.5h9c.83 0 1.5.67 1.5 1.5V13z"/></svg>`, restaurant: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/></svg>`, souvenir: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 6h-2.18c.11-.31.18-.65.18-1a3 3 0 00-3-3c-1.66 0-3 1.34-3 3 0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-1c0-.55.45-1 1-1s1 .45 1 1-.45 1-1 1-1-.45-1-1zM4 8h5.08c-.71.8-1.08 1.87-1.08 3 0 .13.01.26.02.39L4 11.38V8zm16 11H4v-1.38l4.02.01c.17 1.41 1.25 2.53 2.61 2.91l-1.37.92L11 22h2l1.74-1.45-1.37-.92c1.36-.38 2.44-1.5 2.61-2.91l4.02-.01V19z"/></svg>`, activity: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`, };
async function geocodeAddress(address: string): Promise<{lat: number, lon: number} | null> { const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(address)}&countrycodes=tw&limit=1`; try { const response = await fetch(url, { headers: { 'User-Agent': 'AI-Assistant/1.0' } }); if (!response.ok) { console.error(`Nominatim API error: ${response.statusText}`); return null; } const data = await response.json(); if (data && data.length > 0) { return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }; } console.warn(`Could not geocode address: ${address}`); return null; } catch (error) { console.error('Error during geocoding:', error); return null; } }
async function initInteractiveMap(container: HTMLElement, suggestions: any[], userLocation: MessageContent['userLocation']): Promise<{ map: any, markers: any[] } | null> { try { if (typeof L === 'undefined') { throw new Error('Leaflet library is not loaded.'); } if (!userLocation) { throw new Error('User location is not available for map initialization.'); } container.innerHTML = ''; const userPosition: [number, number] = [userLocation.coords.latitude, userLocation.coords.longitude]; const map = L.map(container).setView(userPosition, 13); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map); const userIcon = L.divIcon({ html: '<div class="user-marker-glyph"></div>', className: '', iconSize: [20, 20], iconAnchor: [10, 10] }); L.marker(userPosition, { icon: userIcon, title: '您的位置' }).addTo(map); const markerBounds = L.latLngBounds([userPosition]); const markers: any[] = []; const geocodePromises = suggestions.map((item, index) => geocodeAddress(item.address).then(coords => ({ ...item, coords, index }))); const geocodedSuggestions = await Promise.all(geocodePromises); for (const item of geocodedSuggestions) { if (item.coords) { const position: [number, number] = [item.coords.lat, item.coords.lon]; const iconSvg = iconMap[item.type] || iconMap.activity; const suggestionIcon = L.divIcon({ html: `<div class="map-icon ${item.type}-icon" title="${item.name}">${iconSvg}</div>`, className: '', iconSize: [36, 36], iconAnchor: [18, 36] }); const marker = L.marker(position, { icon: suggestionIcon, title: item.name }).addTo(map); const popupContent = `<div class="map-infowindow"><strong>${item.name} (${item.title.split(' ')[1]})</strong><p>${item.reason || item.description || ''}</p></div>`; marker.bindPopup(popupContent); marker.on('mouseover', () => { const listItem = container.closest('.ai-card')?.querySelector(`li[data-suggestion-index='${item.index + 1}']`); listItem?.classList.add('highlighted'); }); marker.on('mouseout', () => { const listItem = container.closest('.ai-card')?.querySelector(`li[data-suggestion-index='${item.index + 1}']`); listItem?.classList.remove('highlighted'); }); markers[item.index] = marker; markerBounds.extend(position); } } map.fitBounds(markerBounds, { padding: [50, 50] }); return { map, markers }; } catch (error) { console.error("Error initializing interactive map:", error); container.innerHTML = '<p>地圖載入失敗。</p>'; container.style.height = 'auto'; return null; } }

// --- Event Handlers ---

const handleFormSubmit = async () => {
    const userInput = chatInput.value.trim();
    if (!userInput) return;

    messages.push({ role: 'user', content: userInput });
    renderMessages(); // Render user message immediately

    chatInput.value = '';
    chatInput.style.height = 'auto';
    loadingIndicator.style.display = 'flex';
    let userLocation: GeolocationPosition | null = null;

    try {
        // --- Step 1: Role Routing ---
        const routerSchema = {
            type: Type.OBJECT,
            properties: { roleId: { type: Type.STRING, enum: Object.keys(ROLES) } },
            required: ['roleId']
        };
        const routerPrompt = `Analyze the following user query and determine which AI role is best suited to answer it.
User Query: "${userInput}"
Available Roles:
- PERSONAL_ASSISTANT: Handles travel planning, local suggestions, booking, scheduling, and personal life organization.
- FRAUD_DETECTION_AGENT: Analyzes suspicious messages, URLs, phone numbers, and emails to detect potential scams.
- AI_ARCHITECT: Answers technical questions about designing and building AI systems, models, and architecture.
Respond ONLY with a JSON object matching the provided schema.`;

        const routerResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: routerPrompt,
            config: {
                responseMimeType: 'application/json',
                responseSchema: routerSchema,
            }
        });

        const routerResult = JSON.parse(routerResponse.text);
        const newRoleId = routerResult.roleId;

        if (newRoleId && newRoleId !== currentRoleId) {
            await switchRole(newRoleId);
        }

        // --- Step 2: Generate Content with the correct role ---
        const now = new Date();
        const today = now.toLocaleDateString('sv-SE');
        const currentTime = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        
        userLocation = await getCurrentLocation();
        const locationInfo = userLocation ? `我的目前GPS位置在：緯度 ${userLocation.coords.latitude}, 經度 ${userLocation.coords.longitude}。` : '無法取得使用者位置。';
        const contextualizedPrompt = `今天是 ${today}，現在時間是 ${currentTime}。${locationInfo} 我的請求是：「${userInput}」。請根據這些資訊來規劃。`;

        const response: GenerateContentResponse = await chat.sendMessage({ message: contextualizedPrompt });
        const rawText = response.text;

        if (!rawText) {
            messages.push({ role: 'model', content: { data: { summary: '抱歉，我沒有收到任何回覆，請再試一次。' }, userLocation: null, rawResponse: response } });
        } else if (currentRoleId === ROLES.PERSONAL_ASSISTANT.id) {
            const cleanedText = rawText.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
            try {
                const parsedContent = JSON.parse(cleanedText);
                messages.push({ role: 'model', content: { data: parsedContent, userLocation, rawResponse: response } });
            } catch (parseError) {
                console.warn("Could not parse JSON for PA role, treating as plain text:", cleanedText);
                messages.push({ role: 'model', content: { data: { summary: cleanedText }, userLocation: null, rawResponse: response } });
            }
        } else {
            // For other roles, treat as plain text
            messages.push({ role: 'model', content: { data: { summary: rawText }, userLocation, rawResponse: response } });
        }
    } catch (error) {
        console.error("Error during API call:", error);
        messages.push({ role: 'model', content: { data: { summary: '抱歉，我現在遇到一點問題，請稍後再試。' }, userLocation: null } });
    } finally {
        loadingIndicator.style.display = 'none';
        saveMessagesToStorage();
        renderMessages(); // Re-render with model's response
    }
};

chatForm.addEventListener('submit', (e) => { e.preventDefault(); handleFormSubmit(); });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = `${chatInput.scrollHeight}px`; });
chatContainer.addEventListener('click', async (e) => { 
    const target = e.target as HTMLElement; 
    
    // --- Handoff Logic ---
    const handoffButton = target.closest('.handoff-button');
    if (handoffButton) {
        const menu = handoffButton.nextElementSibling as HTMLElement;
        menu?.classList.toggle('hidden');
        return;
    }
    const handoffMenuItem = target.closest<HTMLButtonElement>('.handoff-menu-item');
    if (handoffMenuItem && handoffMenuItem.dataset.handoffRoleId) {
        const newRoleId = handoffMenuItem.dataset.handoffRoleId;
        const card = handoffMenuItem.closest<HTMLDivElement>('.ai-card');
        const summaryEl = card?.querySelector('.summary');
        const summaryText = summaryEl?.textContent?.trim().substring(0, 100) + '...'; // Truncate for prompt
        const previousRoleName = ROLES[currentRoleId].name;
        
        await switchRole(newRoleId);
        
        const newPrompt = `接續前一則由「${previousRoleName}」提供的關於「${summaryText}」的討論，請繼續處理。`;
        chatInput.value = newPrompt;
        chatInput.focus();
        chatInput.style.height = 'auto';
        chatInput.style.height = `${chatInput.scrollHeight}px`;
        return;
    }


    const navButton = target.closest('.navigate-button'); if (navButton instanceof HTMLButtonElement) { const address = navButton.dataset.address; if (address) { window.open(`https://www.google.com/maps/search/?api=1&query=${address}`, '_blank'); } return; } const confirmButton = target.closest('.confirm-button'); if (confirmButton instanceof HTMLButtonElement) { const planMessage = [...messages].reverse().find(m => m.role === 'model' && typeof m.content === 'object' && m.content.data?.event); if (planMessage && typeof planMessage.content === 'object') { const calendarUrl = createGoogleCalendarUrl(planMessage.content.data); if (calendarUrl) { window.open(calendarUrl, '_blank'); confirmButton.textContent = '✅ 已加入行事曆'; confirmButton.disabled = true; } else { alert('無法產生行事曆連結，因為缺少必要的事件或行程資訊。'); confirmButton.textContent = '加入失敗'; } } return; } const listItem = target.closest<HTMLLIElement>('.suggestions-card li[data-suggestion-index]'); if (listItem) { const msgEl = listItem.closest<HTMLDivElement>('.model-message'); if (!msgEl) return; const mapData = mapInstances.get(msgEl); if (!mapData || !mapData.map || !mapData.markers) return; const index = parseInt(listItem.dataset.suggestionIndex || '0', 10); const marker = mapData.markers[index - 1]; if (marker) { mapData.map.flyTo(marker.getLatLng(), 16, { animate: true, duration: 1 }); marker.openPopup(); } } });
chatContainer.addEventListener('mouseover', (e) => { const target = e.target as HTMLElement; const listItem = target.closest<HTMLLIElement>('.suggestions-card li[data-suggestion-index]'); if (!listItem) return; const msgEl = listItem.closest<HTMLDivElement>('.model-message'); if (!msgEl) return; const mapData = mapInstances.get(msgEl); if (!mapData || !mapData.map || !mapData.markers) return; const index = parseInt(listItem.dataset.suggestionIndex || '0', 10); const marker = mapData.markers[index - 1]; if (marker) { marker.openPopup(); } });
chatContainer.addEventListener('mouseout', (e) => { const target = e.target as HTMLElement; const listItem = target.closest<HTMLLIElement>('.suggestions-card li[data-suggestion-index]'); if (!listItem) return; const msgEl = listItem.closest<HTMLDivElement>('.model-message'); if (!msgEl) return; const mapData = mapInstances.get(msgEl); if (!mapData || !mapData.markers) return; const index = parseInt(listItem.dataset.suggestionIndex || '0', 10); const marker = mapData.markers[index - 1]; if (marker) { marker.closePopup(); } });

roleSwitchButton.addEventListener('click', () => {
    const isExpanded = roleSwitchButton.getAttribute('aria-expanded') === 'true';
    roleSwitchButton.setAttribute('aria-expanded', String(!isExpanded));
    roleSelectionMenu.classList.toggle('hidden');
});

roleSelectionMenu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const menuItem = target.closest<HTMLButtonElement>('.role-menu-item');
    if (menuItem && menuItem.dataset.roleId) {
        switchRole(menuItem.dataset.roleId);
    }
});


// --- Voice Input (Speech Recognition) ---
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let recognition: any | null = null;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false; recognition.lang = 'zh-TW'; recognition.interimResults = false; recognition.maxAlternatives = 1;
    micButton.addEventListener('click', () => { if (recognition) { try { recognition.start(); micButton.classList.add('recording'); micButton.disabled = true; chatInput.placeholder = '正在聆聽...'; } catch(e) { console.error("Speech recognition could not be started: ", e); micButton.classList.remove('recording'); micButton.disabled = false; } } });
    recognition.onresult = (event: any) => { const speechResult = event.results[0][0].transcript; chatInput.value = speechResult; chatInput.style.height = 'auto'; chatInput.style.height = `${chatInput.scrollHeight}px`; handleFormSubmit(); };
    recognition.onspeechend = () => { recognition?.stop(); };
    recognition.onend = () => { micButton.classList.remove('recording'); micButton.disabled = false; chatInput.placeholder = '請告訴我您的旅遊計畫...'; };
    recognition.onerror = (event: any) => { console.error('Speech recognition error:', event.error); if(event.error === 'not-allowed' || event.error === 'service-not-allowed') { alert('麥克風權限未開啟。請允許使用麥克風以啟用語音輸入。'); } micButton.classList.remove('recording'); micButton.disabled = false; chatInput.placeholder = '請告訴我您的旅遊計畫...'; };
} else { micButton.style.display = 'none'; console.warn('Speech Recognition not supported in this browser.'); }


// --- App Initialization ---
const initializeApp = () => {
    loadStateFromStorage();
    updateRoleDisplay();
    populateRoleMenu();
    recreateChatInstance();
    renderMessages();
    updateUserStatus();
};

initializeApp();

// --- PWA Service Worker Registration ---
if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').then(r => console.log('SW registered: ', r)).catch(e => console.log('SW registration failed: ', e)); }); }