const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
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
  if (contract.etudiant && contract.entreprise) {
    contract.status = 'ready';
  } else if (contract.etudiant || contract.entreprise) {
    contract.status = 'partial';
  } else {
    contract.status = 'pending';
  }
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
        profile: {}
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
      const baseUrl = getBaseUrl(req);
      const contracts = await getAllContracts();
      const result = contracts.map(c => ({
        id: c.id,
        createdAt: c.createdAt,
        status: c.status,
        etudiantComplete: !!c.etudiant,
        entrepriseComplete: !!c.entreprise,
        liens: {
          etudiant: `${baseUrl}/etudiant.html?token=${c.tokens.etudiant}`,
          entreprise: `${baseUrl}/entreprise.html?token=${c.tokens.entreprise}`
        }
      }));
      return sendJSON(res, result);
    }

    // ---------- POST /api/contracts ----------
    if (method === 'POST' && url === '/api/contracts') {
      const contractId = uuid();
      const etudiantToken = uuid();
      const entrepriseToken = uuid();
      const baseUrl = getBaseUrl(req);

      const contract = {
        id: contractId,
        createdAt: new Date().toISOString(),
        status: 'pending',
        tokens: { etudiant: etudiantToken, entreprise: entrepriseToken },
        etudiant: null, entreprise: null, formation: null
      };

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
      return sendJSON(res, {
        type,
        contractId: contract.id,
        data: contract[type],
        complete: !!contract[type]
      });
    }

    // ---------- POST /api/etudiant/:token ----------
    const etuMatch = matchRoute(url, '/api/etudiant/:token');
    if (method === 'POST' && etuMatch) {
      const result = await getContractByToken(etuMatch.token);
      if (!result || result.type !== 'etudiant') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      result.contract.etudiant = body;
      updateContractStatus(result.contract);
      await saveContract(result.contract);
      return sendJSON(res, { success: true, message: 'Données étudiant enregistrées' });
    }

    // ---------- POST /api/entreprise/:token ----------
    const entMatch = matchRoute(url, '/api/entreprise/:token');
    if (method === 'POST' && entMatch) {
      const result = await getContractByToken(entMatch.token);
      if (!result || result.type !== 'entreprise') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      result.contract.entreprise = body;
      updateContractStatus(result.contract);
      await saveContract(result.contract);
      return sendJSON(res, { success: true, message: 'Données entreprise enregistrées' });
    }

    // ---------- GET /api/contracts/:id/generate-pdf ----------
    const pdfMatch = matchRoute(url, '/api/contracts/:id/generate-pdf');
    if (method === 'GET' && pdfMatch) {
      const contract = await getContract(pdfMatch.id);
      if (!contract) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      if (contract.status !== 'ready') {
        return sendJSON(res, { error: 'Le contrat n\'est pas complet', etudiantComplete: !!contract.etudiant, entrepriseComplete: !!contract.entreprise }, 400);
      }

      const pdfBytes = fs.readFileSync(CERFA_TEMPLATE);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const form = pdfDoc.getForm();
      const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
      const mergedData = { ...contract.entreprise, ...contract.etudiant };
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

      const pdfOut = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cerfa_contrat_${pdfMatch.id.slice(0, 8)}.pdf"`);
      return res.end(Buffer.from(pdfOut));
    }

    // ---------- DELETE /api/contracts/:id ----------
    const delMatch = matchRoute(url, '/api/contracts/:id');
    if (method === 'DELETE' && delMatch) {
      const deleted = await deleteContractFromDB(delMatch.id);
      if (deleted) return sendJSON(res, { success: true });
      return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
    }

    // ---------- 404 ----------
    return sendJSON(res, { error: 'Route non trouvée', url, method }, 404);

  } catch (error) {
    console.error('[API ERROR]', error);
    return sendJSON(res, { error: error.message }, 500);
  }
};
