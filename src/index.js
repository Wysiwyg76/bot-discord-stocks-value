import { env } from "cloudflare:workers";
import { assetLabels } from './assets.js';



/* =======================
   CONSTANTES & UTILS
======================= */

function getRemainingDaysInWeek() {
  const now = new Date();

  const target = new Date(now);
  const day = now.getDay(); // 0 = dimanche

  // Mardi = 2
  let daysUntilTuesday = (2 - day + 7) % 7;

  target.setDate(now.getDate() + daysUntilTuesday);
  target.setHours(9, 1, 0, 0);

  // Si on est déjà passé après mardi 09:01 → semaine suivante
  if (target <= now) {
    target.setDate(target.getDate() + 7);
  }

  return target - now;
}

function getSecondBusinessDay(year, month) {
  let date = new Date(year, month, 1);
  let businessDays = 0;

  while (true) {
    const day = date.getDay();

    if (day >= 1 && day <= 5) { // lundi → vendredi
      businessDays++;
      if (businessDays === 2) {
        date.setHours(9, 1, 0, 0);
        return date;
      }
    }
    date.setDate(date.getDate() + 1);
  }
}

function getRemainingDaysInMonth() {
  const now = new Date();

  let target = getSecondBusinessDay(
    now.getFullYear(),
    now.getMonth()
  );

  // Si la date est déjà passée → mois suivant
  if (target <= now) {
    target = getSecondBusinessDay(
      now.getFullYear(),
      now.getMonth() + 1
    );
  }

  return target - now;
}


const IS_GLOBAL = env.IS_GLOBAL === "true";

/* TODO : pb Cold Start */
const TTL = {
  PRICE: 24 * 60 * 60 * 1000, // 24h
  RSI_WEEKLY: getRemainingDaysInWeek(), // temps jusqu'à mardi 9h01
  RSI_MONTHLY: getRemainingDaysInMonth(), // temps jusqu'au 2ème jour ouvré du mois prochain
};

const now = () => Date.now();
const isExpired = (ts, ttl) => !ts || now() - ts > ttl;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));




/* =======================
   FETCH PRIX (Yahoo Finance)
======================= */

async function getPrice(symbol, env) {
  const cacheKey = `PRICE_${symbol}`;
  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');
  if (cached && !isExpired(cached.ts, TTL.PRICE)) return cached.value;

  await sleep(1500); // pause pour ne pas spammer Yahoo

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/"
      }
    });
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose;
    const lastClose = [...closes].reverse().find(v => typeof v === 'number');

    if (typeof lastClose !== 'number') throw new Error('No valid closing price');

    await env.ASSET_CACHE.put(
      cacheKey,
      JSON.stringify({ value: lastClose, ts: now() })
    );
    return lastClose;

  } catch (e) {
    console.log(`Yahoo price error ${symbol}`, e.message);
    return cached?.value ?? null;
  }
}



/* =======================
   RSI CALCULATOR
======================= */

function calculateRSIseries(closes, period = 14) {
  if (!closes || closes.length <= period) return null;

  const rsi = [];
  let gains = 0, losses = 0;

  // Initialisation
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing (rma)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}




/* =======================
   GET RSI (Hebdo / Mensuel)
======================= */

async function getRSI(symbol, interval, env) {
  const cacheKey = `RSI_${interval}_${symbol}`;
  const ttl = interval === 'weekly' ? TTL.RSI_WEEKLY : TTL.RSI_MONTHLY;

  // Vérifie cache
  const cached = await env.ASSET_CACHE.get(cacheKey, 'json');
  if (cached && !isExpired(cached.ts, ttl)) return cached;

  await sleep(1500); // pause pour ne pas spammer Yahoo

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5y&interval=${interval === 'weekly' ? '1wk' : '1mo'}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://finance.yahoo.com/"
      }
    });

    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose;

    if (!Array.isArray(closes) || closes.length < 15) {
      console.log(`Yahoo RSI warning: not enough data for ${symbol} ${interval}`);
      return cached ?? null;
    }

    const rsiSeries = calculateRSIseries(closes);

    //console.log(`RSI ${symbol} ${interval}`,rsiSeries);

    const currentRSI = rsiSeries.at(-1);
    const previousRSI = rsiSeries.at(-2);

    const result = {
      current: currentRSI,
      previous: previousRSI,
      ts: now()
    };

    await env.ASSET_CACHE.put(cacheKey, JSON.stringify(result));
    return result;

  } catch (e) {
    console.log(`Yahoo RSI error ${symbol} ${interval}`, e.message);
    return cached ?? null;
  }
}



/* =======================
   FORMATAGE MESSAGE
======================= */

const arrow = (c, p) => typeof c === 'number' && typeof p === 'number' ? c > p*1.02 ? '⬈' : c < p*0.98 ? '⬊' : '➞' : '➞';

const safe0 = v => typeof v === 'number' ? v.toFixed(0) : 'N/A';
const safe = v => typeof v === 'number' ? v.toFixed(1) : 'N/A';

const pad = (str, len) => String(str ?? '').padEnd(len, ' ').slice(0, len);

const padRight = (str, len) => String(str ?? '').padStart(len, ' ').slice(-len);

function rsiLabel(rsi) {
  if (typeof rsi !== 'number') return '—';
  if (rsi >= 70) return '🔥 surachat';
  if (rsi >= 55) return '📈 haussier';
  if (rsi >= 45) return '➖ neutre';
  if (rsi >= 30) return '📉 baissier';
  return '❄️ survente';
}

function assetRow(asset, w, m, price, symbol) {
  const currency = asset.currency || '';
  return [
    pad(asset.name, 10),
    pad(symbol.replace(/\..*$/, ""), 7),
    padRight(`${safe(price)} ${currency}`, 10),
    pad(`${safe0(w?.current)} ${arrow(w?.current, w?.previous)}`, 5),
    pad(`${safe0(m?.current)} ${arrow(m?.current, m?.previous)}`, 5)
  ].join(' | ');
}

function assetsTable(assetsRows) {
  if (!assetsRows.length) return '(vide)';
  
  const header =
    pad('Actif', 10) + ' | ' +
    pad('Symbol', 7) + ' | ' +
    pad('Prix', 10) + ' | ' +
    pad('RSI W', 5) + ' | ' +
    pad('RSI M', 5);

  const separator =
    '-----------|---------|------------|-------|-------';

  const rows = assetsRows.map(i => {
    return assetRow(i.asset, i.w, i.m, i.price, i.symbol);
  });

  return (
    '```\n' +
    header + '\n' +
    separator + '\n' +
    rows.join('\n') +
    '\n```'
  );
}

function assetSingleMessage(asset, w, m, price, symbol) {
  const currency = asset.currency || '?';

  return (
    `**${asset.name}**\n` +
    `• Prix : **${safe(price)} ${currency}**\n` +
    `• Hebdo : **${rsiLabel(w?.current)}** (${safe0(w?.current)})\n` +
    `• Mensuel : **${rsiLabel(m?.current)}** (${safe0(m?.current)})`
  );
}

function assetsMessage(items) {
  if (items.length === 1) {
    const { symbol, asset, w, m, price } = items[0];
    return assetSingleMessage(asset, w, m, price, symbol);
  }

  return assetsTable(items);
}



/* =======================
   DISCORD UTILS
======================= */

async function sendDiscordDM(userId, content, env) {
  // Crée (ou récupère) le DM channel
  const dmRes = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ recipient_id: userId })
  });

  const dm = await dmRes.json();

  // Envoie le message
  await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
}

function discordStartMessage() {
  const assets = Object.values(assetLabels).map(a => `••${a.name}••`).join('\n');

  return (
    `Sélectionne un actif en utilisant la commande :\n` +
    `\`/asset <nom>\`\n\n` +
    `Actifs disponibles :\n${assets}\n\n` +
    `Ou : \`/all\``
  );
}

// Vérification signature Discord (Ed25519)
/*
import nacl from "tweetnacl";

function verifyDiscordRequest(request, env) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const body = request.body; // ArrayBuffer ou string
  if (!signature || !timestamp) return false;

  const message = new TextEncoder().encode(timestamp + body);
  return nacl.sign.detached.verify(
    message,
    Buffer.from(signature, "hex"),
    Buffer.from(env.DISCORD_PUBLIC_KEY, "hex")
  );
}
*/

/* =======================
   BUILD MESSAGE
======================= */
async function buildAssetsMessageForSubset(env, subset) {
  const items = [];

  for (const s of subset) {
    const w = await getRSI(s, 'weekly', env);
    const m = await getRSI(s, 'monthly', env);
    const p = await getPrice(s, env);

    items.push({
      symbol: s,
      asset: assetLabels[s],
      w,
      m,
      price: p
    });
  }

  return items;
}

function buildFinalMessage(items) {
  const date = new Date().toLocaleDateString('fr-FR');
  let msg = `*📅 ${date}*\n\n`;

  msg += assetsMessage(items);

  return msg;
}



/* =======================
   DEPLOY CMDS
======================= */

// Commandes à déployer
const commands = [
  { name: "start", description: "Démarre l'interaction avec le bot Stocks Value", type: 1 },
  { name: "all", description: "Récapitulatif de tous les actifs", type: 1 },
  {
    name: "asset",
    description: "Affiche un actif en particulier",
    type: 1,
    options: [
      {
        name: "id",
        description: "Nom de l'actif",
        type: 3,
        required: true,
      },
    ],
  },
];

// Déploiement automatique des commandes
async function deployCommands(env) {
  const BASE_URL = env.IS_GLOBAL
    ? `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/commands`
    : `https://discord.com/api/v10/applications/${env.DISCORD_APP_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;

  for (const cmd of commands) {
    try {
      const res = await fetch(BASE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cmd),
      });
      const data = await res.json();
      if (res.ok) console.log(`✅ Commande enrôlée : /${cmd.name}`);
      else console.error(`❌ Erreur /${cmd.name} :`, data);
    } catch (err) {
      console.error(`❌ Exception /${cmd.name} :`, err);
    }
  }
}



/* =======================
   WORKER
======================= */

export default {
  async fetch(req, env) {

    // Déployer les commandes au démarrage (une seule fois par cold start)
    if (!globalThis.commandsDeployed) {
      await deployCommands(env);
      globalThis.commandsDeployed = true;
    }

    if (req.method !== 'POST') return new Response('OK');

    const interaction = await req.json();

    // Ping Discord
    if (interaction.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const userId = interaction.member?.user?.id;
    if (!userId) return new Response('OK');

    /* à conserver ? 
    const allowed = env.ALLOWED_USER_IDS
      .split(',')
      .map(id => id.trim());

    if (!allowed.includes(userId)) {
      return Response.json({
        type: 4,
        data: { content: 'Unauthorized' }
      });
    }*/

    const command = interaction.data.name;

    if (command === 'start') {
      await sendDiscordDM(userId, discordStartMessage(), env);
    }

    if (command === 'all') {
      const items = await buildAssetsMessageForSubset(
        env,
        Object.keys(assetLabels)
      );
      const msg = buildFinalMessage(items);
      await sendDiscordDM(userId, msg, env);
    }

    if (command === 'asset') {
      const name = interaction.data.options?.[0]?.value;
      const symbol = Object.keys(assetLabels).find(
        k => assetLabels[k].name === name
      );
      if (!symbol) return new Response('OK');

      const items = await buildAssetsMessageForSubset(env, [symbol]);
      const msg = buildFinalMessage(items);
      await sendDiscordDM(userId, msg, env);
    }

    return Response.json({
      type: 4,
      data: { content: '📬 Message envoyé en DM' }
    });
  },

  async scheduled(_, env) {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 2 = mardi
    const dayOfMonth = today.getDate();

    // Chat1 à chaque fois
    const CHAT1_ASSETS = ['ESE.PA','VERX.AS','PAASI.PA','PPFB.DE','BTC-USD'];
    const items = await buildAssetsMessageForSubset(env, CHAT1_ASSETS);
    const msg = buildFinalMessage(items);
    await sendDiscordDM(env.DISCORD_USER_ID1, msg, env);

    // Chat2 uniquement le 2ème mardi du mois
    const firstDayOfMonth = new Date(today.getFullYear(),today.getMonth(),1).getDay();
    const daysUntilFirstTuesday = (2-firstDayOfMonth+7)%7;
    const secondTuesday = 1 + daysUntilFirstTuesday + 7;

    if(dayOfMonth===secondTuesday){
      const CHAT2_ASSETS = ['WPEA.PA'];
      //const items2 = await buildAssetsMessageForSubset(env, CHAT2_ASSETS);
      //const msg2 = buildFinalMessage(items2);
      //await sendDiscordDM(env.DISCORD_USER_ID2,msg2+`\n\n✨ Padawan ✨\nVenue est l’heure de ton investissement mensuel.\n`,env);
    }
  }
};