// ============================================
//  WOOD FARM — Backend Claim Signer
//  Endpoint: POST /api/sign-claim
//  v1.1 — World ID DESACTIVADO temporalmente
// ============================================

const { ethers } = require('ethers');
const admin = require('firebase-admin');

const CONFIG = {
  CHAIN_ID: 480,
  WOOD_SWAP: '0x26b8c5725391D02390b948ff929cf506aE492eDb',
  BRZL_TOKEN: '0xD021eE02CD3854A5D1e82cBeBdF277ce0DC96dA4',
  CLAIM_SIGNER_PRIVATE_KEY: process.env.CLAIM_SIGNER_PRIVATE_KEY,
  FIREBASE_PROJECT_ID: 'wood-farm-90d95',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),

  COOLDOWN_SEC: 6 * 60 * 60,
  LOCK_SEC: 24 * 60 * 60,
  GLOBAL_DAILY_CAP_BRZL: 10000,
  DEADLINE_SEC: 5 * 60,

  TIER_LIMITS: {
    0: 50, 1: 100, 2: 200, 3: 500, 4: 1000
  },

  WOOD_PER_BRZL: 100
};

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: CONFIG.FIREBASE_PROJECT_ID,
        clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL,
        privateKey: CONFIG.FIREBASE_PRIVATE_KEY
      })
    });
  } catch (e) {
    console.error('Firebase init error:', e);
  }
}
const db = admin.firestore();

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function randomNonce() {
  return '0x' + Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const { address, amount } = req.body || {};

    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ ok: false, error: 'INVALID_ADDRESS' });
    }
    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
    }
    if (amount > 10000) {
      return res.status(400).json({ ok: false, error: 'AMOUNT_TOO_LARGE' });
    }

    const userAddr = address.toLowerCase();
    const userRef = db.collection('users').doc(userAddr);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
    }

    const user = userSnap.data();

    // ============ VALIDACIÓN: WORLD ID (DESACTIVADA TEMP) ============
    // if (!user.worldIdVerified) {
    //   return res.status(403).json({ ok: false, error: 'WORLD_ID_REQUIRED' });
    // }

    // ============ VALIDACIÓN: WOOD DISPONIBLE ============
    const woodNeeded = amount * CONFIG.WOOD_PER_BRZL;
    if ((user.pending || 0) < woodNeeded) {
      return res.status(400).json({
        ok: false,
        error: 'INSUFFICIENT_WOOD',
        needed: woodNeeded,
        have: user.pending || 0
      });
    }

    // ============ VALIDACIÓN: COOLDOWN 6H ============
    const lastClaim = user.lastClaimAt || 0;
    const cooldownLeft = lastClaim + CONFIG.COOLDOWN_SEC - nowSec();
    if (cooldownLeft > 0) {
      return res.status(429).json({
        ok: false,
        error: 'COOLDOWN_ACTIVE',
        secondsLeft: cooldownLeft
      });
    }

    // ============ VALIDACIÓN: LÍMITE DIARIO POR TIER ============
    const tier = user.tier || 0;
    const tierLimit = CONFIG.TIER_LIMITS[tier] || CONFIG.TIER_LIMITS[0];
    const today = todayKey();
    const userDaily = user.dailyClaim || {};
    const claimedToday = userDaily[today] || 0;

    if (claimedToday + amount > tierLimit) {
      return res.status(429).json({
        ok: false,
        error: 'DAILY_LIMIT_EXCEEDED',
        limit: tierLimit,
        claimedToday,
        canClaim: Math.max(0, tierLimit - claimedToday)
      });
    }

    // ============ VALIDACIÓN: CAP GLOBAL DEL DÍA ============
    const globalRef = db.collection('global').doc('treasury');
    const globalSnap = await globalRef.get();
    const global = globalSnap.exists ? globalSnap.data() : {};
    const globalDaily = global.dailyOut || {};
    const globalClaimedToday = globalDaily[today] || 0;

    if (globalClaimedToday + amount > CONFIG.GLOBAL_DAILY_CAP_BRZL) {
      return res.status(429).json({
        ok: false,
        error: 'GLOBAL_CAP_REACHED',
        cap: CONFIG.GLOBAL_DAILY_CAP_BRZL,
        claimedToday: globalClaimedToday
      });
    }

    // ============ TODO OK - FIRMAR ============
    const wallet = new ethers.Wallet(CONFIG.CLAIM_SIGNER_PRIVATE_KEY);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const deadline = nowSec() + CONFIG.DEADLINE_SEC;
    const nonce = randomNonce();

    const messageHash = ethers.solidityPackedKeccak256(
      ['string', 'address', 'uint256', 'address', 'uint256', 'uint256', 'bytes32'],
      [
        'WOODSWAP_CLAIM',
        CONFIG.WOOD_SWAP,
        CONFIG.CHAIN_ID,
        userAddr,
        amountWei,
        deadline,
        nonce
      ]
    );

    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    // ============ ACTUALIZAR FIREBASE (atómico) ============
    await db.runTransaction(async (tx) => {
      const u = await tx.get(userRef);
      const uData = u.data();

      const newPending = (uData.pending || 0) - woodNeeded;

      const newDaily = { ...(uData.dailyClaim || {}) };
      newDaily[today] = (newDaily[today] || 0) + amount;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}`;
      Object.keys(newDaily).forEach(k => {
        if (k < cutoffKey) delete newDaily[k];
      });

      tx.update(userRef, {
        pending: newPending,
        dailyClaim: newDaily,
        lastClaimAt: nowSec(),
        totalClaimed: (uData.totalClaimed || 0) + amount
      });

      const g = await tx.get(globalRef);
      const gData = g.exists ? g.data() : { dailyOut: {} };
      const gDaily = { ...(gData.dailyOut || {}) };
      gDaily[today] = (gDaily[today] || 0) + amount;
      Object.keys(gDaily).forEach(k => {
        if (k < cutoffKey) delete gDaily[k];
      });

      tx.set(globalRef, {
        dailyOut: gDaily,
        totalOut: (gData.totalOut || 0) + amount,
        lastUpdate: nowSec()
      }, { merge: true });
    });

    return res.status(200).json({
      ok: true,
      amount: amountWei.toString(),
      deadline,
      nonce,
      signature,
      tierLimit,
      claimedToday: claimedToday + amount,
      remaining: tierLimit - (claimedToday + amount)
    });

  } catch (err) {
    console.error('sign-claim error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', detail: err.message });
  }
};
