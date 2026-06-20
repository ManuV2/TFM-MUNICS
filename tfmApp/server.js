// ═══════════════════════════════════════════════════════════
//  DOCCHAIN — server.js
//  Red TFM: ministerio / cgpj / fiscalia / abogados
//  Chaincode: docregistry (LevelDB)
// ═══════════════════════════════════════════════════════════

'use strict';

require('reflect-metadata');

require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const grpc     = require('@grpc/grpc-js');
const multer   = require('multer');
const { connect, hash, signers } = require('@hyperledger/fabric-gateway');

const app = express();
app.use(express.json());

// ── Multer — almacenamiento temporal para subidas ─────────
const upload = multer({
  dest: path.join(__dirname, 'temp'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// URL del nodo IPFS local
const IPFS_URL = process.env.IPFS_URL || '/ip4/127.0.0.1/tcp/5001';
const IPFS_GATEWAY_URL = process.env.IPFS_GATEWAY_URL || 'http://localhost:8080';

// ── Sesión ────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'docchain-dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

// ── Protección de rutas ───────────────────────────────────
app.use((req, res, next) => {
  const PUBLIC  = ['/login.html', '/api/auth/users', '/api/auth/login'];
  const isAsset = /\.(css|js|png|ico|woff2?|ttf)$/.test(req.path);
  if (PUBLIC.some(p => req.path.startsWith(p)) || isAsset) return next();
  if (req.path.startsWith('/api/') && !req.session?.userId)  return next();
  if (!req.session?.userId) return res.redirect('/login.html');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));


// ═══════════════════════════════════════════════════════════
//  CONFIGURACIÓN DE LA RED
// ═══════════════════════════════════════════════════════════

const CRYPTO_PATH    = process.env.CRYPTO_PATH    || path.join(__dirname, '..', 'fabric-samples', 'tfm-network', 'crypto-config');
const CHANNEL_NAME   = process.env.CHANNEL_NAME   || 'tfmcanal';
const CHAINCODE_NAME = process.env.CHAINCODE_NAME || 'docregistry';

const ORG_CONFIG = {
  'ministerio.tfm.com': {
    label:        'Ministerio de Justicia',
    mspId:        'MinisterioMSP',
    peerEndpoint: 'localhost:7051',
    peerAlias:    'peer0.ministerio.tfm.com',
    tlsCert:      'peerOrganizations/ministerio.tfm.com/peers/peer0.ministerio.tfm.com/tls/ca.crt',
  },
  'cgpj.tfm.com': {
    label:        'CGPJ',
    mspId:        'CGPJMSP',
    peerEndpoint: 'localhost:9051',
    peerAlias:    'peer0.cgpj.tfm.com',
    tlsCert:      'peerOrganizations/cgpj.tfm.com/peers/peer0.cgpj.tfm.com/tls/ca.crt',
  },
  'fiscalia.tfm.com': {
    label:        'Fiscalia',
    mspId:        'FiscaliaMSP',
    peerEndpoint: 'localhost:11051',
    peerAlias:    'peer0.fiscalia.tfm.com',
    tlsCert:      'peerOrganizations/fiscalia.tfm.com/peers/peer0.fiscalia.tfm.com/tls/ca.crt',
  },
  'abogados.tfm.com': {
    label:        'Abogados',
    mspId:        'AbogadosMSP',
    peerEndpoint: 'localhost:13051',
    peerAlias:    'peer0.abogados.tfm.com',
    tlsCert:      'peerOrganizations/abogados.tfm.com/peers/peer0.abogados.tfm.com/tls/ca.crt',
  },
};


// ═══════════════════════════════════════════════════════════
//  LEER IDENTIDADES DE cryptogen
// ═══════════════════════════════════════════════════════════

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.includes(':Zone.Identifier'));
}

function discoverUsers() {
  const users = [];
  for (const [org, cfg] of Object.entries(ORG_CONFIG)) {
    const usersPath = path.join(CRYPTO_PATH, 'peerOrganizations', org, 'users');
    if (!fs.existsSync(usersPath)) continue;

    for (const userFolder of listFiles(usersPath)) {
      const mspPath     = path.join(usersPath, userFolder, 'msp');
      const certDir     = path.join(mspPath, 'signcerts');
      const keystoreDir = path.join(mspPath, 'keystore');

      const certFiles = listFiles(certDir).filter(f => f.endsWith('.pem'));
      const keyFiles  = listFiles(keystoreDir).filter(f => f.endsWith('_sk'));
      if (!certFiles.length || !keyFiles.length) continue;

      const roleName    = userFolder.split('@')[0];
      const displayName = `${roleName} — ${cfg.label}`;

      users.push({
        id:          `${cfg.mspId}::${userFolder}`,
        displayName,
        org,
        mspId:       cfg.mspId,
        roleName,
        userFolder,
        certPath:    path.join(certDir,     certFiles[0]),
        keyPath:     path.join(keystoreDir, keyFiles[0]),
      });
    }
  }
  return users;
}

function getInitials(displayName) {
  return displayName
    .split(/[\s—–-]+/).filter(Boolean)
    .slice(0, 2).map(p => p[0].toUpperCase()).join('');
}

/**
 * Calcula el ID exacto que el chaincode asigna a un usuario.
 * Fabric construye el ID como: MSPID::base64("x509::<Subject>::<Issuer>")
 * donde Subject e Issuer son los DN del certificado X.509 en formato OpenSSL.
 */
function getChaincodeUserId(mspId, certPath, userFolder) {
  try {
    const { X509Certificate } = require('@peculiar/x509');
    const certPem = fs.readFileSync(certPath).toString();
    const cert    = new X509Certificate(certPem);

    function fixDN(dn) {
      return dn
        .split(', ')
        .reverse()
        .join(',');
    }

    const subject = fixDN(cert.subject);
    const issuer  = fixDN(cert.issuer);
    const inner   = `x509::${subject}::${issuer}`;
    const b64     = Buffer.from(inner).toString('base64');
    return `${mspId}::${b64}`;
  } catch (e) {
    console.warn('[getChaincodeUserId] Fallback:', e.message);
    return `${mspId}::${userFolder}`;
  }
}


// ═══════════════════════════════════════════════════════════
//  FABRIC GATEWAY
// ═══════════════════════════════════════════════════════════

const connections = new Map();

async function getContract(userId) {
  if (connections.has(userId)) return connections.get(userId).contract;

  const users      = discoverUsers();
  const userConfig = users.find(u => u.id === userId);
  if (!userConfig) throw new Error(`Usuario no encontrado: ${userId}`);

  const orgCfg = ORG_CONFIG[userConfig.org];
  if (!orgCfg) throw new Error(`Org no configurada: ${userConfig.org}`);

  const certPem    = fs.readFileSync(userConfig.certPath).toString();
  const keyPem     = fs.readFileSync(userConfig.keyPath).toString();
  const credentials= Buffer.from(certPem);
  const privateKey = crypto.createPrivateKey(keyPem);
  const signer     = signers.newPrivateKeySigner(privateKey);

  const tlsCertPath = path.join(CRYPTO_PATH, orgCfg.tlsCert);
  const tlsCert     = fs.readFileSync(tlsCertPath);
  const tlsCreds    = grpc.credentials.createSsl(tlsCert);
  const client      = new grpc.Client(orgCfg.peerEndpoint, tlsCreds, {
    'grpc.ssl_target_name_override': orgCfg.peerAlias,
  });

  const gateway = connect({
    client,
    identity: { mspId: orgCfg.mspId, credentials },
    signer,
    hash: hash.sha256,
    evaluateOptions:     () => ({ deadline: Date.now() + 10000  }),
    endorseOptions:      () => ({ deadline: Date.now() + 120000 }),
    submitOptions:       () => ({ deadline: Date.now() + 60000  }),
    commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
  });

  const network  = gateway.getNetwork(CHANNEL_NAME);
  const contract = network.getContract(CHAINCODE_NAME);

  connections.set(userId, { gateway, client, contract });
  console.log(`[Gateway] Conectado: ${userId} → ${orgCfg.peerEndpoint}`);
  return contract;
}

function closeConnection(userId) {
  if (connections.has(userId)) {
    const { gateway, client } = connections.get(userId);
    try { gateway.close(); } catch (_) {}
    try { client.close();  } catch (_) {}
    connections.delete(userId);
  }
}

function decode(bytes) {
  const str = Buffer.from(bytes).toString('utf8');
  if (!str || str === 'null') return null;
  return JSON.parse(str);
}


// ═══════════════════════════════════════════════════════════
//  MIDDLEWARE AUTH
// ═══════════════════════════════════════════════════════════

function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ message: 'Sesion no iniciada' });
  next();
}


// ═══════════════════════════════════════════════════════════
//  RUTAS DE AUTENTICACION
// ═══════════════════════════════════════════════════════════

app.get('/api/auth/users', (req, res) => {
  try {
    const users = discoverUsers().map(u => ({
      id:          u.id,
      displayName: u.displayName,
      org:         u.org,
      orgLabel:    ORG_CONFIG[u.org]?.label || u.org,
      mspId:       u.mspId,
      roleName:    u.roleName,
      initials:    getInitials(u.displayName),
    }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ message: 'userId requerido' });

  try {
    await getContract(userId);
    const users = discoverUsers();
    const user  = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    req.session.userId      = userId;
    req.session.displayName = user.displayName;
    req.session.mspId       = user.mspId;
    req.session.org         = user.org;
    req.session.orgLabel    = ORG_CONFIG[user.org]?.label || user.org;
    req.session.initials    = getInitials(user.displayName);

    res.json({ ok: true, user: {
      id:       userId,
      name:     user.displayName,
      org:      user.org,
      orgLabel: ORG_CONFIG[user.org]?.label || user.org,
      mspId:    user.mspId,
      initials: getInitials(user.displayName),
    }});
  } catch (e) {
    res.status(500).json({ message: 'Error al conectar con Fabric: ' + e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  closeConnection(req.session.userId);
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  // Devolver el ID en formato Base64 que usa el chaincode internamente
  const users       = discoverUsers();
  const user        = users.find(u => u.id === req.session.userId);
  const chaincodeId = user
    ? getChaincodeUserId(user.mspId, user.certPath, user.userFolder)
    : req.session.userId;

  res.json({
    id:       chaincodeId,
    name:     req.session.displayName,
    org:      req.session.org,
    orgLabel: req.session.orgLabel,
    mspId:    req.session.mspId,
    initials: req.session.initials,
  });
});

// GET /api/users — lista de destinatarios con su ID real del chaincode
app.get('/api/users', requireAuth, (req, res) => {
  try {
    const users = discoverUsers()
      .filter(u => u.id !== req.session.userId)
      .map(u => ({
        chaincodeId: getChaincodeUserId(u.mspId, u.certPath, u.userFolder),
        displayName: u.displayName,
        org:         u.org,
        orgLabel:    ORG_CONFIG[u.org]?.label || u.org,
        mspId:       u.mspId,
        initials:    getInitials(u.displayName),
      }));
    res.json(users);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


// ═══════════════════════════════════════════════════════════
//  RUTAS DEL CHAINCODE
// ═══════════════════════════════════════════════════════════

app.get('/api/chaincode/inbox', requireAuth, async (req, res) => {
  try {
    const result = await (await getContract(req.session.userId)).evaluateTransaction('GetInbox');
    res.json(decode(result) || []);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/chaincode/sent', requireAuth, async (req, res) => {
  try {
    const result = await (await getContract(req.session.userId)).evaluateTransaction('GetSent');
    res.json(decode(result) || []);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/chaincode/my-shipments', requireAuth, async (req, res) => {
  try {
    const result = await (await getContract(req.session.userId)).evaluateTransaction('GetMyShipments');
    res.json(decode(result) || []);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// submitTransaction porque GetShipment escribe la auditoria en el ledger
app.get('/api/chaincode/shipment/:id', requireAuth, async (req, res) => {
  try {
    const result   = await (await getContract(req.session.userId)).submitTransaction('GetShipment', req.params.id);
    const shipment = decode(result);
    if (!shipment) return res.status(404).json({ message: 'Envio no encontrado' });
    res.json(shipment);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.get('/api/chaincode/history/:id', requireAuth, async (req, res) => {
  try {
    const result = await (await getContract(req.session.userId)).evaluateTransaction('GetShipmentHistory', req.params.id);
    res.json(decode(result) || []);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chaincode/send', requireAuth, async (req, res) => {
  const { recipientId, ipfsHash, fileName, fileType, fileSize, description } = req.body;
  if (!recipientId || !ipfsHash)
    return res.status(400).json({ message: 'recipientId e ipfsHash son obligatorios' });

  const shipmentId = 'SHP-' + Date.now() + '-' +
    Math.random().toString(36).substring(2, 7).toUpperCase();

  try {
    await (await getContract(req.session.userId)).submitTransaction(
      'SendDocument', shipmentId, recipientId, ipfsHash,
      fileName || 'documento.pdf', fileType || 'application/pdf',
      String(fileSize || 0), description || ''
    );
    res.json({ ok: true, shipmentId });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chaincode/status', requireAuth, async (req, res) => {
  const { shipmentId, status } = req.body;
  if (!shipmentId || !status)
    return res.status(400).json({ message: 'shipmentId y status son obligatorios' });
  if (!['READ', 'CONFIRMED', 'REJECTED'].includes(status))
    return res.status(400).json({ message: 'Estado no valido' });

  try {
    await (await getContract(req.session.userId)).submitTransaction('UpdateStatus', shipmentId, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chaincode/access', requireAuth, async (req, res) => {
  const { shipmentId } = req.body;
  if (!shipmentId) return res.status(400).json({ message: 'shipmentId es obligatorio' });
  try {
    await (await getContract(req.session.userId)).submitTransaction('RegisterAccess', shipmentId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

app.post('/api/chaincode/delete', requireAuth, async (req, res) => {
  const { shipmentId } = req.body;
  if (!shipmentId) return res.status(400).json({ message: 'shipmentId es obligatorio' });
  try {
    await (await getContract(req.session.userId)).submitTransaction('RegisterDeletion', shipmentId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
});


// ═══════════════════════════════════════════════════════════
//  RUTAS DE IPFS
// ═══════════════════════════════════════════════════════════

app.post('/api/ipfs/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No se recibio ningun fichero' });
  const tempPath = req.file.path;
  try {
    const { create } = await import('kubo-rpc-client');
    const ipfs = create({ url: IPFS_URL });
    const fileContent = fs.readFileSync(tempPath);
    const { cid } = await ipfs.add(fileContent, { pin: true });
    res.json({
      ok:       true,
      cid:      cid.toString(),
      fileName: req.file.originalname,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
    });
  } catch (e) {
    console.error('[IPFS upload]', e.message);
    res.status(500).json({ message: 'Error al subir a IPFS: ' + e.message });
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

app.delete('/api/ipfs/unpin/:cid', requireAuth, async (req, res) => {
  const { cid } = req.params;
  if (!cid) return res.status(400).json({ message: 'CID requerido' });
  try {
    const { create, CID } = await import('kubo-rpc-client');
    const ipfs = create({ url: IPFS_URL });
    await ipfs.pin.rm(CID.parse(cid));
    res.json({ ok: true });
  } catch (e) {
    console.error('[IPFS unpin]', e.message);
    res.status(500).json({ message: 'Error al eliminar pin de IPFS: ' + e.message });
  }
});


// ═══════════════════════════════════════════════════════════
//  ARRANQUE
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
// Configuración pública para el frontend
app.get('/api/config', requireAuth, (req, res) => {
  res.json({ ipfsGateway: IPFS_GATEWAY_URL });
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   DocChain TFM — http://localhost:${PORT}       ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\nMapa de peers:`);
  for (const [org, cfg] of Object.entries(ORG_CONFIG)) {
    console.log(`  ${cfg.label.padEnd(25)} [${cfg.mspId}] → ${cfg.peerEndpoint}`);
  }
  console.log(`\nCanal: ${CHANNEL_NAME}  |  Chaincode: ${CHAINCODE_NAME}`);
  const users = discoverUsers();
  console.log(`\nIdentidades detectadas (${users.length}):`);
  users.forEach(u => console.log(`  · [${u.mspId}] ${u.displayName}`));
  if (!users.length) console.warn(`  ⚠️  Ninguna. Revisa CRYPTO_PATH en .env`);
  console.log('');
});
