const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'cerfa-saas-secret-change-me';
const JWT_EXPIRES_IN = '7d';

// =====================
// UPSTASH REDIS REST API (serverless-friendly)
// =====================
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCall(command) {
  const response = await fetch(`${UPSTASH_URL}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Redis API error: ${response.status} ${text}`);
  }
  const data = await response.json();
  return data.result;
}

// Clés Redis
const CONTRACTS_KEY = 'contracts'; // Hash: contractId -> JSON
const TOKENS_KEY = 'tokens';       // Hash: token -> { contractId, type }
const USERS_KEY = 'users';         // Hash: email -> JSON { id, email, password, role, createdAt, profile }
const MA_KEY_PREFIX = 'maitres:';  // Hash per CFA: maitres:{cfaId} -> maId -> JSON
const ENT_DIR_KEY = 'entreprises_directory'; // Hash: SIRET -> JSON { siret, denomination, code_ape, idcc, effectif, adresse, code_postal, commune, telephone, courriel, ... }
const SIGN_TOKENS_KEY = 'sign_tokens'; // Hash: signToken -> JSON { contractId, role, email, name, expiresAt }

// =====================
// REDIS HELPERS (via REST API)
// =====================
async function getContract(contractId) {
  try {
    const data = await redisCall(['HGET', CONTRACTS_KEY, contractId]);
    if (!data) return null;
    return JSON.parse(data);
  } catch (e) {
    console.error('[REDIS ERROR] getContract:', e.message);
    return null;
  }
}

async function saveContract(contract) {
  try {
    await redisCall(['HSET', CONTRACTS_KEY, contract.id, JSON.stringify(contract)]);
  } catch (e) {
    console.error('[REDIS ERROR] saveContract:', e.message);
  }
}

async function getAllContracts() {
  try {
    const all = await redisCall(['HGETALL', CONTRACTS_KEY]);
    if (!all || all.length === 0) return [];
    // HGETALL retourne un array [key1, val1, key2, val2, ...]
    const contracts = [];
    for (let i = 1; i < all.length; i += 2) {
      contracts.push(JSON.parse(all[i]));
    }
    return contracts;
  } catch (e) {
    console.error('[REDIS ERROR] getAllContracts:', e.message);
    return [];
  }
}

async function deleteContractFromDB(contractId) {
  try {
    const contract = await getContract(contractId);
    if (!contract) return false;
    await redisCall(['HDEL', CONTRACTS_KEY, contractId]);
    if (contract.tokens) {
      await redisCall(['HDEL', TOKENS_KEY, contract.tokens.etudiant]);
      await redisCall(['HDEL', TOKENS_KEY, contract.tokens.entreprise]);
    }
    return true;
  } catch (e) {
    console.error('[REDIS ERROR] deleteContractFromDB:', e.message);
    return false;
  }
}

async function getContractByToken(token) {
  try {
    const tokenData = await redisCall(['HGET', TOKENS_KEY, token]);
    if (!tokenData) return null;
    const parsed = JSON.parse(tokenData);
    const contract = await getContract(parsed.contractId);
    if (!contract) return null;
    return { contract, type: parsed.type };
  } catch (e) {
    console.error('[REDIS ERROR] getContractByToken:', e.message);
    return null;
  }
}

async function saveTokenMapping(token, contractId, type) {
  try {
    await redisCall(['HSET', TOKENS_KEY, token, JSON.stringify({ contractId, type })]);
  } catch (e) {
    console.error('[REDIS ERROR] saveTokenMapping:', e.message);
  }
}

// =====================
// AUTH HELPERS
// =====================
async function getUserByEmail(email) {
  try {
    const data = await redisCall(['HGET', USERS_KEY, email.toLowerCase()]);
    if (!data) return null;
    return JSON.parse(data);
  } catch (e) {
    console.error('[REDIS ERROR] getUserByEmail:', e.message);
    return null;
  }
}

async function saveUser(user) {
  try {
    await redisCall(['HSET', USERS_KEY, user.email.toLowerCase(), JSON.stringify(user)]);
  } catch (e) {
    console.error('[REDIS ERROR] saveUser:', e.message);
  }
}

async function getAllUsers() {
  try {
    const all = await redisCall(['HGETALL', USERS_KEY]);
    if (!all || all.length === 0) return [];
    const users = [];
    for (let i = 1; i < all.length; i += 2) {
      const u = JSON.parse(all[i]);
      delete u.password;
      users.push(u);
    }
    return users;
  } catch (e) {
    console.error('[REDIS ERROR] getAllUsers:', e.message);
    return [];
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verifyToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, roles = []) {
  const user = verifyToken(req);
  if (!user) {
    sendJSON(res, { error: 'Non authentifié' }, 401);
    return null;
  }
  if (roles.length > 0 && !roles.includes(user.role)) {
    sendJSON(res, { error: 'Accès non autorisé' }, 403);
    return null;
  }
  return user;
}

// =====================
// MAITRES D'APPRENTISSAGE HELPERS
// =====================
async function getMaitres(cfaId) {
  try {
    const key = MA_KEY_PREFIX + cfaId;
    const all = await redisCall(['HGETALL', key]);
    if (!all || all.length === 0) return [];
    const maitres = [];
    for (let i = 1; i < all.length; i += 2) {
      maitres.push(JSON.parse(all[i]));
    }
    return maitres;
  } catch (e) {
    console.error('[REDIS ERROR] getMaitres:', e.message);
    return [];
  }
}

async function getMaitre(cfaId, maId) {
  try {
    const data = await redisCall(['HGET', MA_KEY_PREFIX + cfaId, maId]);
    if (!data) return null;
    return JSON.parse(data);
  } catch (e) {
    console.error('[REDIS ERROR] getMaitre:', e.message);
    return null;
  }
}

async function saveMaitre(cfaId, maitre) {
  try {
    await redisCall(['HSET', MA_KEY_PREFIX + cfaId, maitre.id, JSON.stringify(maitre)]);
  } catch (e) {
    console.error('[REDIS ERROR] saveMaitre:', e.message);
  }
}

async function deleteMaitre(cfaId, maId) {
  try {
    await redisCall(['HDEL', MA_KEY_PREFIX + cfaId, maId]);
    return true;
  } catch (e) {
    console.error('[REDIS ERROR] deleteMaitre:', e.message);
    return false;
  }
}

// =====================
// ENTREPRISES DIRECTORY HELPERS (base partagée)
// =====================
async function getEntrepriseFromDir(siret) {
  try {
    const data = await redisCall(['HGET', ENT_DIR_KEY, siret]);
    if (!data) return null;
    return JSON.parse(data);
  } catch (e) {
    console.error('[REDIS ERROR] getEntrepriseFromDir:', e.message);
    return null;
  }
}

async function saveEntrepriseToDir(entData) {
  if (!entData.siret) return;
  const siret = entData.siret.replace(/\s/g, '');
  if (!/^\d{14}$/.test(siret)) return;
  try {
    const existing = await getEntrepriseFromDir(siret);
    const merged = { ...(existing || {}), ...entData, siret, updatedAt: new Date().toISOString() };
    if (!merged.createdAt) merged.createdAt = new Date().toISOString();
    await redisCall(['HSET', ENT_DIR_KEY, siret, JSON.stringify(merged)]);
  } catch (e) {
    console.error('[REDIS ERROR] saveEntrepriseToDir:', e.message);
  }
}

// =====================
// SIGNATURE HELPERS
// =====================
async function saveSignToken(token, data) {
  try {
    await redisCall(['HSET', SIGN_TOKENS_KEY, token, JSON.stringify(data)]);
  } catch (e) {
    console.error('[REDIS ERROR] saveSignToken:', e.message);
  }
}

async function getSignToken(token) {
  try {
    const data = await redisCall(['HGET', SIGN_TOKENS_KEY, token]);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) return null;
    return parsed;
  } catch (e) {
    console.error('[REDIS ERROR] getSignToken:', e.message);
    return null;
  }
}

async function deleteSignToken(token) {
  try {
    await redisCall(['HDEL', SIGN_TOKENS_KEY, token]);
  } catch (e) {
    console.error('[REDIS ERROR] deleteSignToken:', e.message);
  }
}

function generateSignatureHash(contractId, role, signatureData, timestamp) {
  const payload = `${contractId}|${role}|${signatureData.substring(0, 100)}|${timestamp}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function normalizeStr(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

async function searchEntreprisesDir(query) {
  try {
    const all = await redisCall(['HGETALL', ENT_DIR_KEY]);
    if (!all || all.length === 0) return [];
    // Découper la requête en mots (multi-mots : tous doivent matcher)
    const terms = normalizeStr(query).split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];
    const scored = [];
    for (let i = 1; i < all.length; i += 2) {
      const ent = JSON.parse(all[i]);
      // Construire les champs de recherche normalisés
      const fields = {
        siret: (ent.siret || ''),
        denomination: normalizeStr(ent.denomination),
        commune: normalizeStr(ent.adresse_commune),
        code_postal: (ent.adresse_code_postal || ''),
        code_ape: normalizeStr(ent.code_ape),
        code_naf: normalizeStr(ent.code_naf)
      };
      const searchable = `${fields.siret} ${fields.denomination} ${fields.commune} ${fields.code_postal} ${fields.code_ape} ${fields.code_naf}`;
      // Tous les termes doivent matcher quelque part
      const allMatch = terms.every(t => searchable.includes(t));
      if (!allMatch) continue;
      // Scoring : priorité dénomination > SIRET exact > commune > reste
      let score = 0;
      for (const t of terms) {
        if (fields.denomination.startsWith(t)) score += 10;
        else if (fields.denomination.includes(t)) score += 5;
        if (fields.siret.startsWith(t)) score += 8;
        else if (fields.siret.includes(t)) score += 3;
        if (fields.commune.startsWith(t)) score += 4;
        else if (fields.commune.includes(t)) score += 2;
        if (fields.code_postal.startsWith(t)) score += 3;
        if (fields.code_ape.includes(t)) score += 2;
      }
      scored.push({ ent, score });
    }
    // Trier par score décroissant et limiter à 20
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map(s => s.ent);
  } catch (e) {
    console.error('[REDIS ERROR] searchEntreprisesDir:', e.message);
    return [];
  }
}

// Extraire les données entreprise d'un formulaire soumis pour le directory
function extractEntrepriseDataForDir(entrepriseData) {
  if (!entrepriseData || !entrepriseData.employeur) return null;
  const emp = entrepriseData.employeur;
  const siret = (emp.siret || '').replace(/\s/g, '');
  if (!siret || !/^\d{14}$/.test(siret)) return null;
  return {
    siret,
    denomination: emp.denomination || '',
    code_ape: emp.code_ape || '',
    adresse_numero: emp.adresse_numero || '',
    adresse_voie: emp.adresse_voie || '',
    adresse_complement: emp.adresse_complement || '',
    adresse_code_postal: emp.adresse_code_postal || '',
    adresse_commune: emp.adresse_commune || '',
    telephone: emp.telephone || '',
    courriel: emp.courriel || '',
    effectif: emp.effectif || '',
    idcc: emp.idcc || '',
    code_naf: emp.code_naf || '',
    caisse_retraite_complementaire: entrepriseData.contrat?.caisse_retraite_complementaire || ''
  };
}

// =====================
// FICHIERS & HELPERS
// =====================
function findFile(filename) {
  const candidates = [
    path.join(__dirname, '..', filename),
    path.join(__dirname, filename),
    path.join(process.cwd(), filename)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const MAPPING_FILE = findFile('mapping_complet_v2.json');
const CERFA_TEMPLATE = findFile('cerfa_ apprentissage_10103-14.pdf');

function uuid() { return crypto.randomUUID(); }

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function matchRoute(url, pattern) {
  const patternParts = pattern.split('/');
  const urlParts = url.split('/');
  if (patternParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = urlParts[i];
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

function updateContractStatus(contract) {
  // Ne pas écraser les statuts avancés (validated, completed, signing, signed, archived)
  if (['validated', 'completed', 'signing', 'signed', 'archived'].includes(contract.status)) return;
  if (contract.etudiant && contract.entreprise) {
    contract.status = 'ready';
  } else if (contract.etudiant || contract.entreprise) {
    contract.status = 'partial';
  } else {
    contract.status = 'pending';
  }
}

// Extraire la date de fin du contrat (ISO string) depuis les données entreprise
function getContractEndDate(contract) {
  const ctr = contract.entreprise?.contrat || {};
  const j = ctr.date_fin_contrat_jour;
  const m = ctr.date_fin_contrat_mois;
  const a = ctr.date_fin_contrat_annee;
  if (!j || !m || !a) return null;
  const d = new Date(`${a}-${m.padStart(2,'0')}-${j.padStart(2,'0')}T23:59:59`);
  return isNaN(d.getTime()) ? null : d;
}

// Extraire la date de début du contrat (ISO string)
function getContractStartDate(contract) {
  const ctr = contract.entreprise?.contrat || {};
  const j = ctr.date_debut_contrat_jour;
  const m = ctr.date_debut_contrat_mois;
  const a = ctr.date_debut_contrat_annee;
  if (!j || !m || !a) return null;
  const d = new Date(`${a}-${m.padStart(2,'0')}-${j.padStart(2,'0')}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

// Archivage automatique des contrats échus
async function autoArchiveContracts(contracts) {
  const now = new Date();
  let archived = 0;
  for (const c of contracts) {
    if (c.status === 'archived') continue;
    const endDate = getContractEndDate(c);
    if (endDate && endDate < now) {
      const oldStatus = c.status;
      c.status = 'archived';
      if (!c.history) c.history = [];
      c.history.push({ action: 'auto_archived', from: oldStatus, date: new Date().toISOString(), by: 'system', reason: 'Contrat arrivé à échéance' });
      await saveContract(c);
      archived++;
    }
  }
  return archived;
}

function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

function flattenMapping(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(result, flattenMapping(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

// =====================
// HANDLER PRINCIPAL (Vercel natif + Upstash Redis)
// =====================
module.exports = async function handler(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    // ---------- DEBUG ----------
    if (method === 'GET' && url === '/api/debug') {
      let redisStatus = 'unknown';
      let contractCount = 0;
      try {
        await redisCall(['PING']);
        redisStatus = 'connected';
        const contracts = await getAllContracts();
        contractCount = contracts.length;
      } catch (e) {
        redisStatus = 'error: ' + e.message;
      }
      return sendJSON(res, {
        env: { VERCEL: process.env.VERCEL, hasUpstashUrl: !!process.env.UPSTASH_REDIS_REST_URL },
        paths: {
          MAPPING_FILE, MAPPING_EXISTS: fs.existsSync(MAPPING_FILE),
          CERFA_TEMPLATE, CERFA_EXISTS: fs.existsSync(CERFA_TEMPLATE)
        },
        redis: { status: redisStatus, contractCount }
      });
    }

    // ---------- DEBUG PDF FIELDS ----------
    if (method === 'GET' && url === '/api/debug-pdf-fields') {
      try {
        const pdfBytes = fs.readFileSync(CERFA_TEMPLATE);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const form = pdfDoc.getForm();
        const fields = form.getFields();
        const fieldList = fields.map(f => ({
          name: f.getName(),
          type: f.constructor.name
        }));
        const checkboxes = fieldList.filter(f => f.type === 'PDFCheckBox');
        return sendJSON(res, { total: fieldList.length, checkboxCount: checkboxes.length, checkboxes, allFields: fieldList });
      } catch (e) {
        return sendJSON(res, { error: e.message }, 500);
      }
    }

    // =====================
    // ROUTES AUTH
    // =====================

    // ---------- POST /api/auth/register ----------
    if (method === 'POST' && url === '/api/auth/register') {
      const body = await parseBody(req);
      const { email, password, role, nom } = body;

      if (!email || !password || !role) {
        return sendJSON(res, { error: 'Email, mot de passe et rôle requis' }, 400);
      }
      if (!['cfa', 'entreprise'].includes(role)) {
        return sendJSON(res, { error: 'Rôle invalide (cfa ou entreprise)' }, 400);
      }
      if (password.length < 6) {
        return sendJSON(res, { error: 'Mot de passe trop court (min 6 caractères)' }, 400);
      }

      const existing = await getUserByEmail(email);
      if (existing) {
        return sendJSON(res, { error: 'Un compte existe déjà avec cet email' }, 409);
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = {
        id: uuid(),
        email: email.toLowerCase(),
        password: hashedPassword,
        role,
        nom: nom || '',
        createdAt: new Date().toISOString(),
        profile: nom ? { denomination: nom } : {}
      };

      await saveUser(user);
      const token = generateToken(user);

      return sendJSON(res, {
        success: true,
        token,
        user: { id: user.id, email: user.email, role: user.role, nom: user.nom }
      });
    }

    // ---------- POST /api/auth/login ----------
    if (method === 'POST' && url === '/api/auth/login') {
      const body = await parseBody(req);
      const { email, password } = body;

      if (!email || !password) {
        return sendJSON(res, { error: 'Email et mot de passe requis' }, 400);
      }

      const user = await getUserByEmail(email);
      if (!user) {
        return sendJSON(res, { error: 'Email ou mot de passe incorrect' }, 401);
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return sendJSON(res, { error: 'Email ou mot de passe incorrect' }, 401);
      }

      const token = generateToken(user);

      return sendJSON(res, {
        success: true,
        token,
        user: { id: user.id, email: user.email, role: user.role, nom: user.nom, profile: user.profile }
      });
    }

    // ---------- GET /api/auth/me ----------
    if (method === 'GET' && url === '/api/auth/me') {
      const authUser = requireAuth(req, res);
      if (!authUser) return;

      const user = await getUserByEmail(authUser.email);
      if (!user) return sendJSON(res, { error: 'Utilisateur non trouvé' }, 404);

      return sendJSON(res, {
        id: user.id,
        email: user.email,
        role: user.role,
        nom: user.nom,
        profile: user.profile,
        createdAt: user.createdAt
      });
    }

    // ---------- PUT /api/auth/profile ----------
    if (method === 'PUT' && url === '/api/auth/profile') {
      const authUser = requireAuth(req, res);
      if (!authUser) return;

      const body = await parseBody(req);
      const user = await getUserByEmail(authUser.email);
      if (!user) return sendJSON(res, { error: 'Utilisateur non trouvé' }, 404);

      if (body.nom !== undefined) user.nom = body.nom;
      if (body.profile !== undefined) user.profile = { ...user.profile, ...body.profile };

      await saveUser(user);

      // Si c'est une entreprise, alimenter la base partagée
      if (user.role === 'entreprise' && user.profile && user.profile.siret) {
        const p = user.profile;
        await saveEntrepriseToDir({
          siret: (p.siret || '').replace(/\s/g, ''),
          denomination: p.denomination || '',
          code_ape: p.code_ape || '',
          adresse_voie: p.adresse || '',
          adresse_code_postal: p.code_postal || '',
          adresse_commune: p.commune || '',
          telephone: p.telephone || '',
          courriel: p.email_contact || user.email || ''
        });
      }

      return sendJSON(res, {
        success: true,
        user: { id: user.id, email: user.email, role: user.role, nom: user.nom, profile: user.profile }
      });
    }

    // =====================
    // ROUTES CONTRACTS (protégées par auth CFA)
    // =====================

    // ---------- GET /api/contracts ----------
    if (method === 'GET' && url === '/api/contracts') {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;

      const baseUrl = getBaseUrl(req);
      const allContracts = await getAllContracts();
      const contracts = allContracts.filter(c => c.cfaId === authUser.id);

      // Auto-archivage des contrats échus
      await autoArchiveContracts(contracts);

      const now = new Date();
      const typeContratLabels = {
        '11': 'Premier contrat', '21': 'Renouvellement', '22': 'Renouvellement',
        '31': 'Avenant', '32': 'Avenant', '33': 'Avenant', '34': 'Avenant', '35': 'Avenant', '36': 'Avenant', '37': 'Avenant'
      };
      const result = contracts.map(c => {
        const etu = c.etudiant || {};
        const app = etu.apprenti || {};
        const ent = c.entreprise || {};
        const emp = ent.employeur || {};
        const ctr = ent.contrat || {};
        const form = c.formation || ent.formation || {};

        // Dates du contrat
        const startDate = getContractStartDate(c);
        const endDate = getContractEndDate(c);
        let daysRemaining = null;
        let lifecycleAlert = null;
        if (endDate) {
          daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
          if (daysRemaining < 0) lifecycleAlert = 'expired';
          else if (daysRemaining <= 30) lifecycleAlert = 'urgent';
          else if (daysRemaining <= 60) lifecycleAlert = 'warning';
          else if (daysRemaining <= 90) lifecycleAlert = 'soon';
        }

        return {
          id: c.id,
          createdAt: c.createdAt,
          status: c.status,
          etudiantComplete: !!c.etudiant,
          entrepriseComplete: !!c.entreprise,
          apprentiNom: app.nom_naissance || '',
          apprentiPrenom: app.prenom || '',
          entrepriseDenom: emp.denomination || '',
          entrepriseCommune: emp.adresse_commune || '',
          formationIntitule: form.intitule_precis || form.diplome || '',
          typeContrat: typeContratLabels[ctr.type_contrat] || '',
          typeContratCode: ctr.type_contrat || '',
          dateDebut: startDate ? startDate.toISOString().slice(0,10) : null,
          dateFin: endDate ? endDate.toISOString().slice(0,10) : null,
          daysRemaining,
          lifecycleAlert,
          liens: {
            etudiant: `${baseUrl}/etudiant.html?token=${c.tokens.etudiant}`,
            entreprise: `${baseUrl}/entreprise.html?token=${c.tokens.entreprise}`
          }
        };
      });
      return sendJSON(res, result);
    }

    // ---------- POST /api/contracts ----------
    if (method === 'POST' && url === '/api/contracts') {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;

      const body = await parseBody(req);
      const contractId = uuid();
      const etudiantToken = uuid();
      const entrepriseToken = uuid();
      const baseUrl = getBaseUrl(req);

      // Auto-remplissage CFA depuis le profil
      const cfaUser = await getUserByEmail(authUser.email);
      const cfaProfile = (cfaUser && cfaUser.profile) || {};
      const formation = {
        denomination_cfa: cfaProfile.denomination || '',
        uai_cfa: cfaProfile.uai || '',
        siret_cfa: cfaProfile.siret || '',
        adresse_cfa_numero: cfaProfile.numero || '',
        adresse_cfa_voie: cfaProfile.voie || '',
        adresse_cfa_complement: cfaProfile.complement || '',
        adresse_cfa_code_postal: cfaProfile.code_postal || '',
        adresse_cfa_commune: cfaProfile.commune || ''
      };

      // Lien avec une entreprise inscrite (optionnel)
      let entrepriseEmail = body.entrepriseEmail || null;
      let prefilledEntreprise = null;
      if (body.entrepriseId) {
        // Chercher l'entreprise par ID dans les users
        const allUsers = await getAllUsers();
        const entUser = allUsers.find(u => u.id === body.entrepriseId && u.role === 'entreprise');
        if (entUser) {
          entrepriseEmail = entUser.email;
          // Pré-remplir les données entreprise depuis le profil
          const ep = entUser.profile || {};
          if (ep.denomination || ep.siret) {
            prefilledEntreprise = {
              employeur: {
                denomination: ep.denomination || '',
                siret: (ep.siret || '').replace(/\s/g, ''),
                code_ape: ep.code_ape || '',
                adresse_voie: ep.adresse || '',
                adresse_code_postal: ep.code_postal || '',
                adresse_commune: ep.commune || '',
                telephone: ep.telephone || '',
                courriel: ep.email_contact || ''
              }
            };
          }
        }
      }

      const contract = {
        id: contractId,
        cfaId: authUser.id,
        entrepriseEmail: entrepriseEmail,
        createdAt: new Date().toISOString(),
        status: 'pending',
        tokens: { etudiant: etudiantToken, entreprise: entrepriseToken },
        etudiant: null, entreprise: prefilledEntreprise, formation,
        history: [{ action: 'created', date: new Date().toISOString(), by: authUser.email }]
      };

      if (prefilledEntreprise) {
        contract.status = 'partial';
        contract.history.push({ action: 'entreprise_prefilled', date: new Date().toISOString(), by: 'system' });
      }

      await saveContract(contract);
      await saveTokenMapping(etudiantToken, contractId, 'etudiant');
      await saveTokenMapping(entrepriseToken, contractId, 'entreprise');

      return sendJSON(res, {
        success: true,
        contractId,
        liens: {
          etudiant: `${baseUrl}/etudiant.html?token=${etudiantToken}`,
          entreprise: `${baseUrl}/entreprise.html?token=${entrepriseToken}`
        }
      });
    }

    // ---------- GET /api/contract/by-token/:token ----------
    const tokenMatch = matchRoute(url, '/api/contract/by-token/:token');
    if (method === 'GET' && tokenMatch) {
      const result = await getContractByToken(tokenMatch.token);
      if (!result) return sendJSON(res, { error: 'Token invalide' }, 404);
      const { contract, type } = result;
      const response = {
        type,
        contractId: contract.id,
        data: contract[type],
        complete: !!contract[type]
      };
      // Si type entreprise et pas encore de données, tenter pré-remplissage depuis profil inscrit
      if (type === 'entreprise' && !contract[type] && contract.entrepriseEmail) {
        const entUser = await getUserByEmail(contract.entrepriseEmail);
        if (entUser && entUser.profile) {
          const ep = entUser.profile;
          response.profilePrefill = {
            employeur: {
              denomination: ep.denomination || '',
              siret: (ep.siret || '').replace(/\s/g, ''),
              code_ape: ep.code_ape || '',
              adresse_voie: ep.adresse || '',
              adresse_code_postal: ep.code_postal || '',
              adresse_commune: ep.commune || '',
              telephone: ep.telephone || '',
              courriel: ep.email_contact || ''
            }
          };
        }
      }
      return sendJSON(res, response);
    }

    // ---------- POST /api/etudiant/:token ----------
    const etuMatch = matchRoute(url, '/api/etudiant/:token');
    if (method === 'POST' && etuMatch) {
      const result = await getContractByToken(etuMatch.token);
      if (!result || result.type !== 'etudiant') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      // Validation NIR
      if (body.apprenti?.nir) {
        const nir = body.apprenti.nir.replace(/\s/g, '');
        if (nir && !/^\d{13,15}$/.test(nir)) return sendJSON(res, { error: 'NIR invalide (13 à 15 chiffres)' }, 400);
      }
      result.contract.etudiant = body;
      updateContractStatus(result.contract);
      if (!result.contract.history) result.contract.history = [];
      result.contract.history.push({ action: 'etudiant_submitted', date: new Date().toISOString(), by: 'etudiant' });
      await saveContract(result.contract);
      return sendJSON(res, { success: true, message: 'Données étudiant enregistrées' });
    }

    // ---------- POST /api/entreprise/:token ----------
    const entMatch = matchRoute(url, '/api/entreprise/:token');
    if (method === 'POST' && entMatch) {
      const result = await getContractByToken(entMatch.token);
      if (!result || result.type !== 'entreprise') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      // Validation SIRET
      if (body.employeur?.siret) {
        const siret = body.employeur.siret.replace(/\s/g, '');
        if (siret && !/^\d{14}$/.test(siret)) return sendJSON(res, { error: 'SIRET invalide (14 chiffres requis)' }, 400);
      }
      // Validation email
      if (body.employeur?.courriel) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.employeur.courriel)) return sendJSON(res, { error: 'Email employeur invalide' }, 400);
      }
      result.contract.entreprise = body;
      updateContractStatus(result.contract);
      if (!result.contract.history) result.contract.history = [];
      result.contract.history.push({ action: 'entreprise_submitted', date: new Date().toISOString(), by: 'entreprise' });
      await saveContract(result.contract);
      // Auto-alimenter la base partagée d'entreprises
      const dirData = extractEntrepriseDataForDir(body);
      if (dirData) await saveEntrepriseToDir(dirData);
      return sendJSON(res, { success: true, message: 'Données entreprise enregistrées' });
    }

    // ---------- GET /api/entreprises-directory/search?q=... ----------
    if (method === 'GET' && url.startsWith('/api/entreprises-directory/search')) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q || q.length < 2) return sendJSON(res, []);
      const results = await searchEntreprisesDir(q);
      return sendJSON(res, results);
    }

    // ---------- GET /api/entreprises-directory/:siret (auth CFA) ----------
    const dirMatch = matchRoute(url, '/api/entreprises-directory/:siret');
    if (method === 'GET' && dirMatch && !url.includes('search') && !url.includes('by-siret')) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const ent = await getEntrepriseFromDir(dirMatch.siret);
      if (!ent) return sendJSON(res, { error: 'Entreprise non trouvée dans l\'annuaire' }, 404);
      return sendJSON(res, ent);
    }

    // ---------- GET /api/entreprises-directory/by-siret/:siret (public, lookup exact SIRET) ----------
    const dirPublicMatch = matchRoute(url, '/api/entreprises-directory/by-siret/:siret');
    if (method === 'GET' && dirPublicMatch) {
      const siret = (dirPublicMatch.siret || '').replace(/\s/g, '');
      if (!siret || !/^\d{14}$/.test(siret)) return sendJSON(res, { error: 'SIRET invalide' }, 400);
      const ent = await getEntrepriseFromDir(siret);
      if (!ent) return sendJSON(res, {});
      return sendJSON(res, ent);
    }

    // ---------- GET /api/entreprises (liste des comptes entreprise pour le CFA) ----------
    if (method === 'GET' && url === '/api/entreprises') {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const allUsers = await getAllUsers();
      const entreprises = allUsers.filter(u => u.role === 'entreprise').map(u => ({
        id: u.id, email: u.email, nom: u.nom, profile: u.profile || {}
      }));
      return sendJSON(res, entreprises);
    }

    // ---------- GET /api/entreprise/contracts (contrats liés à l'entreprise connectée) ----------
    if (method === 'GET' && url === '/api/entreprise/contracts') {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const user = await getUserByEmail(authUser.email);
      const profile = (user && user.profile) || {};
      const allContracts = await getAllContracts();
      // Matcher par email OU par SIRET du profil entreprise
      const myContracts = allContracts.filter(c => {
        if (c.entrepriseEmail && c.entrepriseEmail.toLowerCase() === authUser.email.toLowerCase()) return true;
        if (profile.siret && c.entreprise && c.entreprise.employeur) {
          const contractSiret = (c.entreprise.employeur.siret || '').replace(/\s/g, '');
          const profileSiret = (profile.siret || '').replace(/\s/g, '');
          if (contractSiret && profileSiret && contractSiret === profileSiret) return true;
        }
        return false;
      });
      // Récupérer les noms des CFA
      const allUsers = await getAllUsers();
      const cfaMap = {};
      allUsers.filter(u => u.role === 'cfa').forEach(u => { cfaMap[u.id] = u.nom || u.profile?.denomination || u.email; });

      const result = myContracts.map(c => ({
        id: c.id,
        createdAt: c.createdAt,
        status: c.status,
        etudiantComplete: !!c.etudiant,
        entrepriseComplete: !!c.entreprise,
        apprentiNom: c.etudiant?.apprenti?.nom_naissance || '',
        apprentiPrenom: c.etudiant?.apprenti?.prenom || '',
        formationIntitule: c.entreprise?.formation?.intitule_precis || c.formation?.intitule_precis || '',
        cfaNom: cfaMap[c.cfaId] || 'CFA inconnu',
        lienFormulaire: c.tokens ? `/entreprise.html?token=${c.tokens.entreprise}` : null
      }));
      return sendJSON(res, result);
    }

    // ---------- PUT /api/entreprise/contracts/:id/archive (entreprise archive/désarchive) ----------
    const entArchiveMatch = matchRoute(url, '/api/entreprise/contracts/:id/archive');
    if (method === 'PUT' && entArchiveMatch) {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const contract = await getContract(entArchiveMatch.id);
      if (!contract) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      // Vérifier que le contrat appartient à cette entreprise
      const user = await getUserByEmail(authUser.email);
      const profile = (user && user.profile) || {};
      let owns = false;
      if (contract.entrepriseEmail && contract.entrepriseEmail.toLowerCase() === authUser.email.toLowerCase()) owns = true;
      if (!owns && profile.siret && contract.entreprise && contract.entreprise.employeur) {
        const cSiret = (contract.entreprise.employeur.siret || '').replace(/\s/g, '');
        const pSiret = (profile.siret || '').replace(/\s/g, '');
        if (cSiret && pSiret && cSiret === pSiret) owns = true;
      }
      if (!owns) return sendJSON(res, { error: 'Accès refusé' }, 403);
      const body = await parseBody(req);
      const archive = body.archive !== false; // true = archiver, false = désarchiver
      const prevStatus = contract.status;
      if (archive) {
        contract.statusBeforeArchive = contract.status;
        contract.status = 'archived';
        contract.archivedAt = new Date().toISOString();
      } else {
        contract.status = contract.statusBeforeArchive || 'completed';
        delete contract.statusBeforeArchive;
        delete contract.archivedAt;
      }
      if (!contract.history) contract.history = [];
      contract.history.push({ action: archive ? 'archived_by_entreprise' : 'unarchived_by_entreprise', by: authUser.email, at: new Date().toISOString(), from: prevStatus, to: contract.status });
      await saveContract(contract);
      return sendJSON(res, { success: true, status: contract.status });
    }

    // ---------- GET /api/contracts/:id/generate-pdf ----------
    const pdfMatch = matchRoute(url, '/api/contracts/:id/generate-pdf');
    if (method === 'GET' && pdfMatch) {
      const contract = await getContract(pdfMatch.id);
      if (!contract) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      if (!['ready', 'validated', 'signing', 'signed', 'completed'].includes(contract.status)) {
        return sendJSON(res, { error: 'Le contrat n\'est pas complet', status: contract.status, etudiantComplete: !!contract.etudiant, entrepriseComplete: !!contract.entreprise }, 400);
      }

      const pdfBytes = fs.readFileSync(CERFA_TEMPLATE);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const form = pdfDoc.getForm();
      const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
      const mergedData = { ...contract.entreprise, ...contract.etudiant, ...(contract.formation || {}) };
      const flatData = flattenObject(mergedData);
      const flatMap = flattenMapping(mapping);
      let filledCount = 0;

      for (const [dataKey, pdfFieldName] of Object.entries(flatMap)) {
        const value = flatData[dataKey];
        if (value === undefined || value === null || value === '') continue;
        try {
          const field = form.getField(pdfFieldName);
          const type = field.constructor.name;
          if (type === 'PDFTextField') { field.setText(String(value)); filledCount++; }
          else if (type === 'PDFCheckBox') {
            if (value === true || value === 'true' || value === 'OUI' || value === 'on') { field.check(); filledCount++; }
          }
        } catch (e) { /* champ non trouvé */ }
      }

      // Si le contrat a des signatures, ajouter une page de signatures + audit trail
      const hasSigs = contract.signature && contract.signature.parties && contract.signature.parties.some(p => p.signed);
      if (hasSigs) {
        // Fonction pour nettoyer les caracteres non-WinAnsi (pdf-lib Helvetica)
        function sanitize(str) {
          return String(str || '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[^\x00-\xFF]/g, '');
        }

        try {
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
        const signPage = pdfDoc.addPage([595.28, 841.89]); // A4
        let currentPage = signPage;
        let y = 800;
        const leftMargin = 50;
        const pageWidth = 595.28;
        const certVersion = 'v1.0';
        const allSigned = contract.signature.parties.every(p => p.signed);

        // Titre
        signPage.drawText('CERTIFICAT DE SIGNATURE ELECTRONIQUE', { x: leftMargin, y, font: fontBold, size: 16, color: rgb(0.118, 0.227, 0.373) });
        y -= 20;
        signPage.drawText('Contrat d\'apprentissage - CERFA 10103-14', { x: leftMargin, y, font, size: 10, color: rgb(0.4, 0.4, 0.4) });
        signPage.drawText('Certificat ' + certVersion, { x: pageWidth - leftMargin - 80, y, font, size: 8, color: rgb(0.6, 0.6, 0.6) });
        y -= 14;
        signPage.drawText(sanitize('Identifiant du contrat : ' + contract.id), { x: leftMargin, y, font, size: 9, color: rgb(0.5, 0.5, 0.5) });
        y -= 10;
        signPage.drawText(sanitize('Empreinte du document (SHA-256) : ' + (contract.signature.documentHash || 'N/A')), { x: leftMargin, y, font, size: 7, color: rgb(0.5, 0.5, 0.5) });
        y -= 10;
        if (allSigned) {
          signPage.drawText('DOCUMENT VERROUILLE - Toute modification est interdite apres signature', { x: leftMargin, y, font: fontBold, size: 7, color: rgb(0.7, 0.1, 0.1) });
          y -= 10;
        }
        y -= 8;

        // Ligne de separation
        signPage.drawLine({ start: { x: leftMargin, y }, end: { x: pageWidth - leftMargin, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
        y -= 18;

        // Statut global
        if (allSigned) {
          signPage.drawText('[OK] TOUTES LES PARTIES ONT SIGNE', { x: leftMargin, y, font: fontBold, size: 12, color: rgb(0.106, 0.369, 0.125) });
        } else {
          const signedCount = contract.signature.parties.filter(p => p.signed).length;
          signPage.drawText('SIGNATURE EN COURS (' + signedCount + '/' + contract.signature.parties.length + ')', { x: leftMargin, y, font: fontBold, size: 12, color: rgb(0.557, 0.141, 0.667) });
        }
        y -= 28;

        const roleLabels = { employeur: 'Employeur', apprenti: 'Apprenti(e)', representant_legal: 'Representant legal', cfa: 'CFA / Organisme de formation' };

        // Pour chaque signataire
        for (const party of contract.signature.parties) {
          // Nouvelle page si on manque de place
          if (y < 140) {
            currentPage = pdfDoc.addPage([595.28, 841.89]);
            y = 800;
          }

          // Cadre
          const boxH = party.signed ? 95 : 60;
          currentPage.drawRectangle({ x: leftMargin, y: y - boxH, width: pageWidth - 2 * leftMargin, height: boxH + 5, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1, color: party.signed ? rgb(0.97, 0.99, 0.97) : rgb(1, 0.98, 0.94) });

          const roleLabel = roleLabels[party.role] || party.role;
          currentPage.drawText(sanitize(roleLabel), { x: leftMargin + 10, y: y - 2, font: fontBold, size: 11, color: rgb(0.118, 0.227, 0.373) });
          currentPage.drawText(sanitize(party.name), { x: leftMargin + 10, y: y - 16, font, size: 10, color: rgb(0.2, 0.2, 0.2) });
          currentPage.drawText(sanitize(party.email || ''), { x: leftMargin + 10, y: y - 30, font, size: 8, color: rgb(0.5, 0.5, 0.5) });

          if (party.signed) {
            currentPage.drawText(sanitize('Signe le ' + new Date(party.signedAt).toLocaleString('fr-FR')), { x: leftMargin + 10, y: y - 46, font, size: 9, color: rgb(0.106, 0.369, 0.125) });
            currentPage.drawText(sanitize('IP: ' + (party.ip || 'N/A') + '  |  User-Agent: ' + (party.userAgent || 'N/A').substring(0, 60)), { x: leftMargin + 10, y: y - 58, font, size: 6, color: rgb(0.6, 0.6, 0.6) });
            currentPage.drawText(sanitize('Hash signature: ' + (party.signatureHash || 'N/A')), { x: leftMargin + 10, y: y - 68, font, size: 6, color: rgb(0.6, 0.6, 0.6) });
            currentPage.drawText('Consentement: le signataire a explicitement accepte de signer ce document par voie electronique', { x: leftMargin + 10, y: y - 80, font: fontItalic, size: 6, color: rgb(0.4, 0.4, 0.4) });

            // Inserer l'image de signature si disponible
            if (party.signatureData && party.signatureData.startsWith('data:image/png;base64,')) {
              try {
                const base64Data = party.signatureData.replace('data:image/png;base64,', '');
                const sigImageBytes = Buffer.from(base64Data, 'base64');
                const sigImage = await pdfDoc.embedPng(sigImageBytes);
                const sigDims = sigImage.scale(0.25);
                const maxW = 150;
                const maxH = 50;
                const ratio = Math.min(maxW / sigDims.width, maxH / sigDims.height, 1);
                currentPage.drawImage(sigImage, {
                  x: pageWidth - leftMargin - (sigDims.width * ratio) - 10,
                  y: y - 85,
                  width: sigDims.width * ratio,
                  height: sigDims.height * ratio
                });
              } catch (imgErr) {
                console.error('[PDF] Erreur insertion image signature:', imgErr.message);
              }
            }
            y -= (boxH + 15);
          } else {
            currentPage.drawText('En attente de signature', { x: leftMargin + 10, y: y - 46, font, size: 9, color: rgb(0.8, 0.5, 0.0) });
            y -= (boxH + 15);
          }
        }

        // Mentions legales en bas
        if (y < 120) {
          currentPage = pdfDoc.addPage([595.28, 841.89]);
          y = 800;
        }
        y -= 10;
        currentPage.drawLine({ start: { x: leftMargin, y }, end: { x: pageWidth - leftMargin, y }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
        y -= 14;
        const legalLines = [
          'MENTIONS LEGALES',
          '',
          'Ce certificat atteste que les signatures ci-dessus ont ete recueillies par voie electronique.',
          'Chaque signataire a donne son consentement explicite avant de signer, en cochant la case',
          '"Je donne mon consentement pour signer ce document par voie electronique".',
          '',
          'Conformement aux articles 1366 et 1367 du Code civil francais et au reglement europeen',
          'eIDAS (UE n 910/2014), la signature electronique a la meme valeur probante que la signature manuscrite.',
          '',
          'Integrite du document : le hash SHA-256 du document a ete calcule au moment de l\'initiation',
          'de la session de signature. Toute modification du contrat apres signature est techniquement',
          'bloquee par le systeme.',
          '',
          sanitize('Signature initiee le ' + new Date(contract.signature.initiatedAt).toLocaleString('fr-FR') + ' par ' + (contract.signature.initiatedBy || 'N/A')),
          sanitize('Document genere le ' + new Date().toLocaleString('fr-FR')),
          'Certificat ' + certVersion + ' - Systeme de signature electronique SaaS CERFA'
        ];
        for (const line of legalLines) {
          if (line === 'MENTIONS LEGALES') {
            currentPage.drawText(line, { x: leftMargin, y, font: fontBold, size: 8, color: rgb(0.3, 0.3, 0.3) });
          } else {
            currentPage.drawText(line, { x: leftMargin, y, font, size: 7, color: rgb(0.5, 0.5, 0.5) });
          }
          y -= 10;
        }
        } catch (certErr) {
          console.error('[PDF] Erreur generation certificat signature:', certErr.message);
        }
      }

      // Aplatir le formulaire si le contrat est signe (rend le PDF non-editable)
      const isSigned = contract.signature && contract.signature.parties && contract.signature.parties.every(p => p.signed);
      if (isSigned || contract.status === 'signed' || contract.status === 'completed') {
        try {
          form.flatten();
        } catch (flatErr) {
          console.error('[PDF] Erreur flatten:', flatErr.message);
        }
      }

      const pdfOut = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cerfa_contrat_${pdfMatch.id.slice(0, 8)}.pdf"`);
      return res.end(Buffer.from(pdfOut));
    }

    // ---------- GET /api/contracts/:id ----------
    const detailMatch = matchRoute(url, '/api/contracts/:id');
    if (method === 'GET' && detailMatch && !url.includes('generate-pdf')) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(detailMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      return sendJSON(res, {
        id: contract.id,
        createdAt: contract.createdAt,
        status: contract.status,
        etudiant: contract.etudiant,
        entreprise: contract.entreprise,
        formation: contract.formation,
        history: contract.history || [],
        tokens: contract.tokens
      });
    }

    // ---------- PUT /api/contracts/:id ----------
    const updateMatch = matchRoute(url, '/api/contracts/:id');
    if (method === 'PUT' && updateMatch && !url.includes('status')) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(updateMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);

      // Verrouillage : interdire modification apres signature
      if (['signed', 'completed'].includes(contract.status) && contract.signature && contract.signature.parties && contract.signature.parties.some(p => p.signed)) {
        return sendJSON(res, { error: 'Ce contrat a ete signe electroniquement et ne peut plus etre modifie. L\'integrite du document est protegee.' }, 403);
      }

      const body = await parseBody(req);
      if (body.etudiant !== undefined) contract.etudiant = { ...contract.etudiant, ...body.etudiant };
      if (body.entreprise !== undefined) contract.entreprise = { ...contract.entreprise, ...body.entreprise };
      if (body.formation !== undefined) contract.formation = { ...contract.formation, ...body.formation };
      updateContractStatus(contract);
      if (!contract.history) contract.history = [];
      contract.history.push({ action: 'updated_by_cfa', date: new Date().toISOString(), by: authUser.email });
      await saveContract(contract);
      // Auto-alimenter la base partagée si données entreprise modifiées
      if (body.entreprise) {
        const dirData = extractEntrepriseDataForDir(contract.entreprise);
        if (dirData) await saveEntrepriseToDir(dirData);
      }
      return sendJSON(res, { success: true, contract: { id: contract.id, status: contract.status } });
    }

    // ---------- PUT /api/contracts/:id/status ----------
    const statusMatch = matchRoute(url, '/api/contracts/:id/status');
    if (method === 'PUT' && statusMatch) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(statusMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);

      const body = await parseBody(req);
      const validStatuses = ['pending', 'partial', 'ready', 'validated', 'signing', 'signed', 'completed', 'archived'];
      if (!body.status || !validStatuses.includes(body.status)) {
        return sendJSON(res, { error: 'Statut invalide. Valeurs: ' + validStatuses.join(', ') }, 400);
      }
      // Verrouillage : interdire retour en arriere depuis signed
      if (['signed'].includes(contract.status) && contract.signature && contract.signature.parties && contract.signature.parties.some(p => p.signed)) {
        const allowedFromSigned = ['completed', 'archived'];
        if (!allowedFromSigned.includes(body.status)) {
          return sendJSON(res, { error: 'Un contrat signe ne peut pas revenir a un statut anterieur. Seuls "completed" et "archived" sont autorises.' }, 403);
        }
      }

      const oldStatus = contract.status;
      contract.status = body.status;
      if (!contract.history) contract.history = [];
      contract.history.push({ action: 'status_changed', from: oldStatus, to: body.status, date: new Date().toISOString(), by: authUser.email });
      await saveContract(contract);
      return sendJSON(res, { success: true, oldStatus, newStatus: body.status });
    }

    // ---------- GET /api/contracts/:id/history ----------
    const histMatch = matchRoute(url, '/api/contracts/:id/history');
    if (method === 'GET' && histMatch) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(histMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      return sendJSON(res, contract.history || []);
    }

    // =====================
    // ROUTES MAITRES D'APPRENTISSAGE
    // =====================

    // ---------- GET /api/maitres/by-token/:token (public, via token entreprise) ----------
    const maByTokenGet = matchRoute(url, '/api/maitres/by-token/:token');
    if (method === 'GET' && maByTokenGet) {
      const result = await getContractByToken(maByTokenGet.token);
      if (!result || result.type !== 'entreprise') return sendJSON(res, { error: 'Token invalide' }, 404);
      const contract = result.contract;
      // Trouver l'entreprise inscrite liée au contrat
      let entrepriseUserId = null;
      if (contract.entrepriseEmail) {
        const entUser = await getUserByEmail(contract.entrepriseEmail);
        if (entUser) entrepriseUserId = entUser.id;
      }
      if (!entrepriseUserId) return sendJSON(res, []);
      const maitres = await getMaitres(entrepriseUserId);
      return sendJSON(res, maitres);
    }

    // ---------- POST /api/maitres/by-token/:token (public, ajouter un maître via formulaire) ----------
    const maByTokenPost = matchRoute(url, '/api/maitres/by-token/:token');
    if (method === 'POST' && maByTokenPost) {
      const result = await getContractByToken(maByTokenPost.token);
      if (!result || result.type !== 'entreprise') return sendJSON(res, { error: 'Token invalide' }, 404);
      const contract = result.contract;
      let entrepriseUserId = null;
      if (contract.entrepriseEmail) {
        const entUser = await getUserByEmail(contract.entrepriseEmail);
        if (entUser) entrepriseUserId = entUser.id;
      }
      if (!entrepriseUserId) return sendJSON(res, { error: 'Aucune entreprise inscrite liée à ce contrat' }, 400);
      const body = await parseBody(req);
      if (!body.nom || !body.prenom) return sendJSON(res, { error: 'Nom et prénom requis' }, 400);
      const maitre = {
        id: uuid(),
        nom: body.nom,
        prenom: body.prenom,
        date_naissance: body.date_naissance || '',
        courriel: body.courriel || '',
        emploi_occupe: body.emploi_occupe || '',
        diplome_le_plus_eleve: body.diplome_le_plus_eleve || '',
        niveau_diplome: body.niveau_diplome || '',
        createdAt: new Date().toISOString()
      };
      await saveMaitre(entrepriseUserId, maitre);
      return sendJSON(res, { success: true, maitre });
    }

    // ---------- GET /api/maitres ----------
    if (method === 'GET' && url === '/api/maitres') {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const maitres = await getMaitres(authUser.id);
      return sendJSON(res, maitres);
    }

    // ---------- POST /api/maitres ----------
    if (method === 'POST' && url === '/api/maitres') {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const body = await parseBody(req);
      if (!body.nom || !body.prenom) return sendJSON(res, { error: 'Nom et prénom requis' }, 400);
      const maitre = {
        id: uuid(),
        nom: body.nom,
        prenom: body.prenom,
        date_naissance: body.date_naissance || '',
        courriel: body.courriel || '',
        emploi_occupe: body.emploi_occupe || '',
        diplome_le_plus_eleve: body.diplome_le_plus_eleve || '',
        niveau_diplome: body.niveau_diplome || '',
        createdAt: new Date().toISOString()
      };
      await saveMaitre(authUser.id, maitre);
      return sendJSON(res, { success: true, maitre });
    }

    // ---------- PUT /api/maitres/:id ----------
    const maUpdateMatch = matchRoute(url, '/api/maitres/:id');
    if (method === 'PUT' && maUpdateMatch) {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const maitre = await getMaitre(authUser.id, maUpdateMatch.id);
      if (!maitre) return sendJSON(res, { error: 'Maître non trouvé' }, 404);
      const body = await parseBody(req);
      const updated = { ...maitre, ...body, id: maitre.id };
      await saveMaitre(authUser.id, updated);
      return sendJSON(res, { success: true, maitre: updated });
    }

    // ---------- DELETE /api/maitres/:id ----------
    const maDelMatch = matchRoute(url, '/api/maitres/:id');
    if (method === 'DELETE' && maDelMatch) {
      const authUser = requireAuth(req, res, ['entreprise']);
      if (!authUser) return;
      const deleted = await deleteMaitre(authUser.id, maDelMatch.id);
      if (deleted) return sendJSON(res, { success: true });
      return sendJSON(res, { error: 'Maître non trouvé' }, 404);
    }

    // =====================
    // SIGNATURE ELECTRONIQUE ROUTES
    // =====================

    // ---------- POST /api/contracts/:id/signature/init (CFA initie la signature) ----------
    const signInitMatch = matchRoute(url, '/api/contracts/:id/signature/init');
    if (method === 'POST' && signInitMatch) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(signInitMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      if (!['ready', 'validated'].includes(contract.status)) {
        return sendJSON(res, { error: 'Le contrat doit être au statut "prêt" ou "validé" pour lancer la signature' }, 400);
      }
      if (!contract.etudiant || !contract.entreprise) {
        return sendJSON(res, { error: 'Le contrat doit être complet (données étudiant et entreprise)' }, 400);
      }

      const body = await parseBody(req);
      // Parties à signer : au minimum employeur et apprenti
      const parties = [];
      const baseUrl = getBaseUrl(req);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 jours

      // Partie Employeur
      const empEmail = body.employeurEmail || contract.entreprise?.employeur?.courriel || contract.entrepriseEmail || '';
      const empNom = contract.entreprise?.employeur?.denomination || 'Employeur';
      const empToken = crypto.randomUUID();
      parties.push({ role: 'employeur', email: empEmail, name: empNom, token: empToken, signed: false });
      await saveSignToken(empToken, { contractId: contract.id, role: 'employeur', email: empEmail, name: empNom, expiresAt });

      // Partie Apprenti
      const appEmail = body.apprentiEmail || contract.etudiant?.apprenti?.courriel || '';
      const appNom = `${contract.etudiant?.apprenti?.prenom || ''} ${contract.etudiant?.apprenti?.nom_naissance || ''}`.trim() || 'Apprenti';
      const appToken = crypto.randomUUID();
      parties.push({ role: 'apprenti', email: appEmail, name: appNom, token: appToken, signed: false });
      await saveSignToken(appToken, { contractId: contract.id, role: 'apprenti', email: appEmail, name: appNom, expiresAt });

      // Partie Représentant légal (optionnel, si mineur)
      if (body.representantLegal || contract.etudiant?.representant_legal?.nom_prenom) {
        const rlEmail = body.representantEmail || contract.etudiant?.representant_legal?.courriel || '';
        const rlNom = contract.etudiant?.representant_legal?.nom_prenom || 'Représentant légal';
        const rlToken = crypto.randomUUID();
        parties.push({ role: 'representant_legal', email: rlEmail, name: rlNom, token: rlToken, signed: false });
        await saveSignToken(rlToken, { contractId: contract.id, role: 'representant_legal', email: rlEmail, name: rlNom, expiresAt });
      }

      // Partie CFA
      const cfaUser = await getUserByEmail(authUser.email);
      const cfaNom = cfaUser?.nom || cfaUser?.profile?.denomination || 'CFA';
      const cfaToken = crypto.randomUUID();
      parties.push({ role: 'cfa', email: authUser.email, name: cfaNom, token: cfaToken, signed: false });
      await saveSignToken(cfaToken, { contractId: contract.id, role: 'cfa', email: authUser.email, name: cfaNom, expiresAt });

      // Sauvegarder dans le contrat
      contract.signature = {
        initiatedAt: new Date().toISOString(),
        initiatedBy: authUser.email,
        expiresAt,
        parties,
        documentHash: crypto.createHash('sha256').update(JSON.stringify({ etudiant: contract.etudiant, entreprise: contract.entreprise, formation: contract.formation })).digest('hex'),
        completed: false
      };
      contract.status = 'signing';
      if (!contract.history) contract.history = [];
      contract.history.push({ action: 'signature_initiated', date: new Date().toISOString(), by: authUser.email, parties: parties.map(p => ({ role: p.role, email: p.email })) });
      await saveContract(contract);

      // Générer les liens de signature
      const links = parties.map(p => ({
        role: p.role,
        name: p.name,
        email: p.email,
        url: `${baseUrl}/signer.html?token=${p.token}`
      }));

      return sendJSON(res, { success: true, signatureId: contract.id, links, expiresAt });
    }

    // ---------- GET /api/signature/:token (récupérer infos de signature publique) ----------
    const signInfoMatch = matchRoute(url, '/api/signature/:token');
    if (method === 'GET' && signInfoMatch) {
      const tokenData = await getSignToken(signInfoMatch.token);
      if (!tokenData) return sendJSON(res, { error: 'Lien de signature invalide ou expiré' }, 404);

      const contract = await getContract(tokenData.contractId);
      if (!contract || !contract.signature) return sendJSON(res, { error: 'Contrat non trouvé ou signature non initiée' }, 404);

      const party = contract.signature.parties.find(p => p.role === tokenData.role && p.email === tokenData.email);
      if (!party) return sendJSON(res, { error: 'Partie non trouvée' }, 404);
      if (party.signed) return sendJSON(res, { error: 'already_signed', message: 'Vous avez déjà signé ce contrat' }, 400);

      // Résumé du contrat pour affichage
      const emp = contract.entreprise?.employeur || {};
      const app = contract.etudiant?.apprenti || {};
      const ctr = contract.entreprise?.contrat || {};
      const frm = contract.entreprise?.formation || contract.formation || {};

      return sendJSON(res, {
        contractId: contract.id,
        role: tokenData.role,
        signerName: tokenData.name,
        signerEmail: tokenData.email,
        documentHash: contract.signature.documentHash,
        expiresAt: contract.signature.expiresAt,
        allParties: contract.signature.parties.map(p => ({ role: p.role, name: p.name, signed: p.signed, signedAt: p.signedAt })),
        summary: {
          employeur: { denomination: emp.denomination || '', siret: emp.siret || '', adresse: `${emp.adresse_numero || ''} ${emp.adresse_voie || ''}, ${emp.adresse_code_postal || ''} ${emp.adresse_commune || ''}`.trim() },
          apprenti: { nom: app.nom_naissance || '', prenom: app.prenom || '', dateNaissance: `${app.date_naissance_jour || ''}/${app.date_naissance_mois || ''}/${app.date_naissance_annee || ''}` },
          contrat: {
            dateDebut: `${ctr.date_debut_contrat_jour || ''}/${ctr.date_debut_contrat_mois || ''}/${ctr.date_debut_contrat_annee || ''}`,
            dateFin: `${ctr.date_fin_contrat_jour || ''}/${ctr.date_fin_contrat_mois || ''}/${ctr.date_fin_contrat_annee || ''}`,
            salaireBrut: ctr.salaire_brut_mensuel || ''
          },
          formation: { intitule: frm.intitule_precis || frm.diplome || '', organisme: frm.denomination_cfa || '' }
        }
      });
    }

    // ---------- POST /api/signature/:token (soumettre une signature) ----------
    const signSubmitMatch = matchRoute(url, '/api/signature/:token');
    if (method === 'POST' && signSubmitMatch) {
      const tokenData = await getSignToken(signSubmitMatch.token);
      if (!tokenData) return sendJSON(res, { error: 'Lien de signature invalide ou expiré' }, 404);

      const contract = await getContract(tokenData.contractId);
      if (!contract || !contract.signature) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);

      const partyIndex = contract.signature.parties.findIndex(p => p.role === tokenData.role && p.email === tokenData.email);
      if (partyIndex === -1) return sendJSON(res, { error: 'Partie non trouvée' }, 404);
      if (contract.signature.parties[partyIndex].signed) return sendJSON(res, { error: 'Vous avez déjà signé ce contrat' }, 400);

      const body = await parseBody(req);
      if (!body.signatureData) return sendJSON(res, { error: 'Données de signature manquantes' }, 400);

      const now = new Date().toISOString();
      const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const signatureHash = generateSignatureHash(contract.id, tokenData.role, body.signatureData, now);

      // Enregistrer la signature
      contract.signature.parties[partyIndex].signed = true;
      contract.signature.parties[partyIndex].signedAt = now;
      contract.signature.parties[partyIndex].signatureData = body.signatureData;
      contract.signature.parties[partyIndex].signatureHash = signatureHash;
      contract.signature.parties[partyIndex].ip = ip;
      contract.signature.parties[partyIndex].userAgent = userAgent;

      if (!contract.history) contract.history = [];
      contract.history.push({ action: 'signed', role: tokenData.role, by: tokenData.email, name: tokenData.name, date: now, ip, signatureHash });

      // Vérifier si toutes les parties ont signé
      const allSigned = contract.signature.parties.every(p => p.signed);
      if (allSigned) {
        contract.signature.completed = true;
        contract.signature.completedAt = new Date().toISOString();
        contract.status = 'signed';
        contract.history.push({ action: 'all_signatures_completed', date: new Date().toISOString() });
      }

      await saveContract(contract);
      await deleteSignToken(signSubmitMatch.token);

      return sendJSON(res, {
        success: true,
        signatureHash,
        allSigned,
        remainingParties: contract.signature.parties.filter(p => !p.signed).map(p => ({ role: p.role, name: p.name }))
      });
    }

    // ---------- GET /api/contracts/:id/signature (statut signature - auth CFA) ----------
    const signStatusMatch = matchRoute(url, '/api/contracts/:id/signature');
    if (method === 'GET' && signStatusMatch && !url.includes('init')) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;
      const contract = await getContract(signStatusMatch.id);
      if (!contract || contract.cfaId !== authUser.id) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      if (!contract.signature) return sendJSON(res, { error: 'Aucune signature initiée pour ce contrat' }, 404);

      const baseUrl = getBaseUrl(req);
      return sendJSON(res, {
        initiatedAt: contract.signature.initiatedAt,
        expiresAt: contract.signature.expiresAt,
        completed: contract.signature.completed,
        completedAt: contract.signature.completedAt || null,
        documentHash: contract.signature.documentHash,
        parties: contract.signature.parties.map(p => ({
          role: p.role,
          name: p.name,
          email: p.email,
          signed: p.signed,
          signedAt: p.signedAt || null,
          signatureHash: p.signatureHash || null,
          url: !p.signed ? `${baseUrl}/signer.html?token=${p.token}` : null
        }))
      });
    }

    // ---------- DELETE /api/contracts/:id ----------
    const delMatch = matchRoute(url, '/api/contracts/:id');
    if (method === 'DELETE' && delMatch) {
      const authUser = requireAuth(req, res, ['cfa']);
      if (!authUser) return;

      const contract = await getContract(delMatch.id);
      if (!contract || contract.cfaId !== authUser.id) {
        return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      }

      const deleted = await deleteContractFromDB(delMatch.id);
      if (deleted) return sendJSON(res, { success: true });
      return sendJSON(res, { error: 'Erreur de suppression' }, 500);
    }

    // ---------- 404 ----------
    return sendJSON(res, { error: 'Route non trouvée', url, method }, 404);

  } catch (error) {
    console.error('[API ERROR]', error);
    return sendJSON(res, { error: error.message }, 500);
  }
};
