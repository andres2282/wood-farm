// ============================================
//  WOOD FARM — Backend v2.0
//  Endpoint: POST /api/sign-claim
//  Soporta 2 modos:
//    - "withdraw": internal BRZL → wallet on-chain (con límite 5K/24h, cooldown 6h, fee 1%)
//    - (legacy): WOOD pending → wallet on-chain (compatibilidad)
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

  // Sistema de retiros
  WITHDRAW_MAX_DAILY: 5000,
  WITHDRAW_COOLDOWN_SEC: 6 * 60 * 60,  // 6h
  WITHDRAW_FEE_PCT: 1,                  // 1% fee

  // Legacy (compatibilidad)
  COOLDOWN_SEC: 6 * 60 * 60,
  GLOBAL_DAILY_CAP_BRZL: 25000,         // subimos a 25K para soportar 5 users full
  DEADLINE_SEC: 5 * 60,
  WOOD_PER_BRZL: 1000
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
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });

  try {
    const { address, amount, mode } = req.body || {};

    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ ok: false, error: 'INVALID_ADDRESS' });
    }
    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({ ok: false, error: 'INVALID_AMOUNT' });
    }
    if (amount > CONFIG.WITHDRAW_MAX_DAILY) {
      return res.status(400).json({ ok: false, error: 'AMOUNT_TOO_LARGE' });
    }

    const userAddr = address.toLowerCase();
    const userRef = db.collection('users').doc(userAddr);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ ok: false, error: 'USER_NOT_FOUND' });
    }

    const user = userSnap.data();
    const isWithdrawMode = mode === 'withdraw';

    // ============ MODO WITHDRAW (internal → wallet) ============
    if (isWithdrawMode) {
      // Validar internalBrzl suficiente
      if ((user.internalBrzl || 0) < amount) {
        return res.status(400).json({
          ok: false, error: 'INSUFFICIENT_BRZL',
          have: user.internalBrzl || 0
        });
      }

      // Validar cooldown 6h
      const lastWithdraw = user.lastWithdrawAt || 0;
      const cooldownLeft = lastWithdraw + CONFIG.WITHDRAW_COOLDOWN_SEC - nowSec();
      if (cooldownLeft > 0) {
        return res.status(429).json({
          ok: false, error: 'COOLDOWN_ACTIVE',
          secondsLeft: cooldownLeft
        });
      }

      // Validar límite diario 5K
      const today = todayKey();
      const userDaily = user.dailyWithdraw || {};
      const withdrawnToday = userDaily[today] || 0;
      if (withdrawnToday + amount > CONFIG.WITHDRAW_MAX_DAILY) {
        return res.status(429).json({
          ok: false, error: 'DAILY_LIMIT_EXCEEDED',
          limit: CONFIG.WITHDRAW_MAX_DAILY,
          withdrawnToday,
          canWithdraw: Math.max(0, CONFIG.WITHDRAW_MAX_DAILY - withdrawnToday)
        });
      }

      // Validar cap global del día
      const globalRef = db.collection('global').doc('treasury');
      const globalSnap = await globalRef.get();
      const global = globalSnap.exists ? globalSnap.data() : {};
      const globalDaily = global.dailyOut || {};
      const globalClaimedToday = globalDaily[today] || 0;
      if (globalClaimedToday + amount > CONFIG.GLOBAL_DAILY_CAP_BRZL) {
        return res.status(429).json({
          ok: false, error: 'GLOBAL_CAP_REACHED',
          cap: CONFIG.GLOBAL_DAILY_CAP_BRZL,
          claimedToday: globalClaimedToday
        });
      }

      // Calcular fee y monto neto
      const fee = Math.ceil(amount * CONFIG.WITHDRAW_FEE_PCT / 100);
      const netAmount = amount - fee;

      // Firmar el netAmount (lo que efectivamente sale del contrato)
      const wallet = new ethers.Wallet(CONFIG.CLAIM_SIGNER_PRIVATE_KEY);
      const amountWei = ethers.parseUnits(netAmount.toString(), 18);
      const deadline = nowSec() + CONFIG.DEADLINE_SEC;
      const nonce = randomNonce();

      const messageHash = ethers.solidityPackedKeccak256(
        ['string', 'address', 'uint256', 'address', 'uint256', 'uint256', 'bytes32'],
        ['WOODSWAP_CLAIM', CONFIG.WOOD_SWAP, CONFIG.CHAIN_ID, userAddr, amountWei, deadline, nonce]
      );
      const signature = await wallet.signMessage(ethers.getBytes(messageHash));

      // Transacción atómica: actualizar internalBrzl, dailyWithdraw, lastWithdrawAt, global
      await db.runTransaction(async (tx) => {
        const u = await tx.get(userRef);
        const g = await tx.get(globalRef);
        const uData = u.data();
        const gData = g.exists ? g.data() : { dailyOut: {}, totalOut: 0 };

        // Limpieza de days antiguos
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoff.getUTCDate()).padStart(2, '0')}`;

        const newDailyWithdraw = { ...(uData.dailyWithdraw || {}) };
        newDailyWithdraw[today] = (newDailyWithdraw[today] || 0) + amount;
        Object.keys(newDailyWithdraw).forEach(k => {
          if (k < cutoffKey) delete newDailyWithdraw[k];
        });

        const gDaily = { ...(gData.dailyOut || {}) };
        gDaily[today] = (gDaily[today] || 0) + amount;
        Object.keys(gDaily).forEach(k => {
          if (k < cutoffKey) delete gDaily[k];
        });

        tx.update(userRef, {
          internalBrzl: (uData.internalBrzl || 0) - amount,
          dailyWithdraw: newDailyWithdraw,
          lastWithdrawAt: nowSec(),
          totalClaimed: (uData.totalClaimed || 0) + amount,
          totalFees: (uData.totalFees || 0) + fee
        });

        tx.set(globalRef, {
          dailyOut: gDaily,
          totalOut: (gData.totalOut || 0) + amount,
          totalFees: (gData.totalFees || 0) + fee,
          lastUpdate: nowSec()
        }, { merge: true });
      });

      return res.status(200).json({
        ok: true,
        mode: 'withdraw',
        amount: amountWei.toString(),
        netAmount,
        fee,
        deadline,
        nonce,
        signature,
        withdrawnToday: withdrawnToday + amount,
        remaining: CONFIG.WITHDRAW_MAX_DAILY - (withdrawnToday + amount)
      });
    }

    // ============ MODO LEGACY (WOOD pending → wallet, compatibilidad) ============
    const woodNeeded = amount * CONFIG.WOOD_PER_BRZL;
    if ((user.pending || 0) < woodNeeded) {
      return res.status(400).json({
        ok: false, error: 'INSUFFICIENT_WOOD',
        needed: woodNeeded, have: user.pending || 0
      });
    }

    const lastClaim = user.lastClaimAt || 0;
    const cooldownLeft = lastClaim + CONFIG.COOLDOWN_SEC - nowSec();
    if (cooldownLeft > 0) {
      return res.status(429).json({ ok: false, error: 'COOLDOWN_ACTIVE', secondsLeft: cooldownLeft });
    }

    const wallet = new ethers.Wallet(CONFIG.CLAIM_SIGNER_PRIVATE_KEY);
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const deadline = nowSec() + CONFIG.DEADLINE_SEC;
    const nonce = randomNonce();
    const messageHash = ethers.solidityPackedKeccak256(
      ['string', 'address', 'uint256', 'address', 'uint256', 'uint256', 'bytes32'],
      ['WOODSWAP_CLAIM', CONFIG.WOOD_SWAP, CONFIG.CHAIN_ID, userAddr, amountWei, deadline, nonce]
    );
    const signature = await wallet.signMessage(ethers.getBytes(messageHash));

    await db.runTransaction(async (tx) => {
      const u = await tx.get(userRef);
      const uData = u.data();
      tx.update(userRef, {
        pending: (uData.pending || 0) - woodNeeded,
        lastClaimAt: nowSec(),
        totalClaimed: (uData.totalClaimed || 0) + amount
      });
    });

    return res.status(200).json({
      ok: true,
      amount: amountWei.toString(),
      deadline,
      nonce,
      signature
    });

  } catch (err) {
    console.error('sign-claim error:', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', detail: err.message });
  }
};
