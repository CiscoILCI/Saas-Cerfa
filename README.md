# 📋 ContratFlow - SaaS CERFA

Application SaaS pour le remplissage automatique du **CERFA 10103-14** (contrat d'apprentissage).

## 🚀 Démarrage rapide

### Prérequis
- **Node.js** 16+ et npm
- **Git**
- Compte **Vercel** (pour déploiement)
- Compte **Upstash** (Redis REST API - gratuit)

### Installation locale

```bash
# 1. Cloner le repo
git clone https://github.com/CiscoILCI/Saas-Cerfa.git
cd Saas-Cerfa

# 2. Installer les dépendances
npm install

# 3. Créer un fichier .env.local (dev local uniquement)
# Pas nécessaire pour le dev local, mais optionnel pour tester Redis
# UPSTASH_REDIS_REST_URL=https://...
# UPSTASH_REDIS_REST_TOKEN=...

# 4. Lancer le serveur local
npm run dev
# → http://localhost:3000
```

### Accès initial

- **URL** : http://localhost:3000
- **Page d'accueil** : Redirection vers login.html
- **Créer un compte** : Cliquer sur "S'inscrire"
  - Rôle : **CFA** ou **Entreprise**
  - Email : n'importe quel email
  - Mot de passe : min 6 caractères

---

## 📁 Structure du projet

```
Saas-Cerfa/
├── api/
│   └── index.js                    ← API Vercel serverless (handler natif)
├── public/
│   ├── login.html                  ← Page de connexion/inscription
│   ├── dashboard-cfa.html          ← Dashboard CFA (contrats, maîtres, profil)
│   ├── dashboard-entreprise.html   ← Dashboard Entreprise (profil, contrats)
│   ├── edit-contrat.html           ← Édition complète du contrat
│   ├── etudiant.html               ← Formulaire apprenti (token)
│   └── entreprise.html             ← Formulaire entreprise (token + auto-lookup SIRET)
├── cerfa_apprentissage_10103-14.pdf ← Template PDF CERFA
├── mapping_complet_v2.json         ← Mapping champs formulaire → PDF
├── package.json
├── vercel.json                     ← Config Vercel
├── server_v2.js                    ← Serveur dev local (Express)
├── progress.md                     ← État du projet (détaillé)
├── PROJECT.md                      ← Roadmap SaaS
└── README.md                       ← Ce fichier
```

---

## 🔧 Développement local

### Commandes npm

```bash
# Lancer le serveur dev local
npm run dev

# Build pour production (optionnel, Vercel le fait automatiquement)
npm run build

# Linter (si configuré)
npm run lint
```

### Structure des données Redis

Les données sont stockées dans **Upstash Redis** via REST API :

```
Clés Redis utilisées :
├── contracts          (Hash) : contractId → JSON du contrat
├── tokens             (Hash) : token → { contractId, type }
├── users              (Hash) : email → { id, email, password, role, profile, createdAt }
├── maitres:{cfaId}    (Hash) : maId → JSON du maître apprentissage
└── entreprises_directory (Hash) : SIRET → { denomination, code_ape, adresse, ... }
```

### Variables d'environnement

#### Dev local
Aucune variable d'env n'est strictement nécessaire (les données sont en mémoire).

Optionnel : pour tester Redis localement, créer un fichier `.env.local` :

```bash
UPSTASH_REDIS_REST_URL=https://your-region-your-id.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
JWT_SECRET=dev-secret-key-change-in-production
```

#### Vercel en production

Ajouter dans **Vercel Dashboard** → **Project Settings** → **Environment Variables** :

```
UPSTASH_REDIS_REST_URL=https://your-region-your-id.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here
JWT_SECRET=votre-secret-jwt-long-et-securise-minimum-32-caracteres
```

---

## 🗄️ Base de données (Redis)

### Upstash Redis (Cloud)

L'application utilise **Upstash Redis** via l'API REST (compatible Vercel serverless).

#### Créer une base de données Upstash

1. Aller sur https://console.upstash.com
2. Créer un compte (gratuit)
3. Créer une nouvelle base de données Redis
   - **Région** : EU-West (Paris) recommandé
   - **Plan** : Free (30 MB gratuit)
4. Copier les credentials :
   - `UPSTASH_REDIS_REST_URL` : URL REST endpoint
   - `UPSTASH_REDIS_REST_TOKEN` : Token d'authentification

#### Ajouter à Vercel

1. Aller sur https://vercel.com/dashboard
2. Sélectionner le projet **saas-cerfa**
3. **Settings** → **Environment Variables**
4. Ajouter les 3 variables :
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   - `JWT_SECRET`
5. Redéployer : `vercel --prod`

#### Vérifier la connexion

```bash
# Tester localement
curl -X POST https://your-url.upstash.io/exec \
  -H "Authorization: Bearer your-token" \
  -d '["PING"]'
# Doit retourner : "PONG"

# Tester en production
curl https://saas-cerfa.vercel.app/api/debug
# Doit retourner : { redis: { status: 'connected', contractCount: X } }
```

### Structure des données Redis

Les données sont organisées en **Hash Redis** (clé → valeur JSON) :

```
Clé                          Type   Contenu
─────────────────────────────────────────────────────────────────
contracts                    Hash   contractId → JSON du contrat
                                    {
                                      id, cfaId, status, createdAt,
                                      etudiant, entreprise, formation,
                                      tokens, history
                                    }

tokens                       Hash   token → { contractId, type }
                                    type = 'etudiant' ou 'entreprise'

users                        Hash   email → JSON utilisateur
                                    {
                                      id, email, password (bcrypt),
                                      role ('cfa' ou 'entreprise'),
                                      profile, createdAt
                                    }

maitres:{cfaId}              Hash   maId → JSON maître apprentissage
                                    {
                                      id, nom, prenom, date_naissance,
                                      courriel, emploi_occupe, diplome,
                                      createdAt
                                    }

entreprises_directory        Hash   SIRET → JSON entreprise
                                    {
                                      siret, denomination, code_ape,
                                      adresse_voie, code_postal, commune,
                                      telephone, courriel, effectif,
                                      idcc, createdAt, updatedAt
                                    }
```

### Accéder à Redis directement

#### Via Upstash Console

1. Aller sur https://console.upstash.com
2. Sélectionner votre base de données
3. Onglet **CLI** pour exécuter des commandes Redis

Exemples :

```redis
# Voir tous les contrats
HGETALL contracts

# Voir tous les utilisateurs
HGETALL users

# Voir l'annuaire d'entreprises
HGETALL entreprises_directory

# Supprimer toutes les données (ATTENTION !)
FLUSHALL
```

#### Via API REST (curl)

```bash
# Récupérer tous les contrats
curl -X POST https://your-url.upstash.io/exec \
  -H "Authorization: Bearer your-token" \
  -d '["HGETALL", "contracts"]'

# Récupérer un utilisateur spécifique
curl -X POST https://your-url.upstash.io/exec \
  -H "Authorization: Bearer your-token" \
  -d '["HGET", "users", "email@example.com"]'

# Supprimer une clé
curl -X POST https://your-url.upstash.io/exec \
  -H "Authorization: Bearer your-token" \
  -d '["DEL", "contracts"]'
```

### Quotas et limites

- **Plan Free** : 30 MB de stockage
- **Commandes** : Illimitées
- **Connexions** : Illimitées
- **Durée de vie** : Données persistantes

### Sauvegarde et restauration

Upstash offre des **snapshots automatiques** (gratuit).

Pour exporter les données :

1. Aller sur https://console.upstash.com
2. Sélectionner votre base
3. **Backup** → Télécharger le snapshot

---

---

## 🌐 Déploiement sur Vercel

### 1. Connecter le repo à Vercel

```bash
# Option A : Via CLI
npm install -g vercel
vercel login
vercel

# Option B : Via interface web
# → https://vercel.com/new
# → Importer depuis GitHub
# → Sélectionner le repo CiscoILCI/Saas-Cerfa
```

### 2. Configurer les variables d'environnement

Dans **Vercel Dashboard** → Project Settings → Environment Variables :

```
UPSTASH_REDIS_REST_URL = https://...
UPSTASH_REDIS_REST_TOKEN = ...
JWT_SECRET = votre-secret-jwt
```

### 3. Déployer

```bash
# Option A : Auto-deploy (recommandé)
# Chaque push sur `main` déclenche un déploiement automatique

# Option B : Déploiement manuel
vercel --prod
```

### 4. Vérifier le déploiement

```bash
# Vérifier que l'API fonctionne
curl https://saas-cerfa.vercel.app/api/debug

# Vérifier que Redis est connecté
# → Doit retourner { redis: { status: 'connected', contractCount: X } }
```

---

## 📝 Workflow de développement

### 1. Créer une branche

```bash
git checkout -b feature/ma-fonctionnalite
```

### 2. Faire des modifications

- Modifier les fichiers HTML/JS dans `public/`
- Modifier l'API dans `api/index.js`
- Tester localement : `npm run dev`

### 3. Committer et pusher

```bash
git add .
git commit -m "Description claire de la modification"
git push origin feature/ma-fonctionnalite
```

### 4. Créer une Pull Request

- Aller sur GitHub
- Créer une PR vers `main`
- Attendre la revue
- Merger dans `main`

### 5. Déploiement automatique

- Vercel détecte le push sur `main`
- Déploiement automatique en ~2-3 minutes
- Vérifier sur https://saas-cerfa.vercel.app

---

## 🧪 Tester l'application

### Flux complet (local ou production)

1. **Créer un compte CFA**
   - Email : `cfa@test.fr`
   - Mot de passe : `password123`
   - Rôle : CFA

2. **Remplir le profil CFA**
   - Dashboard CFA → Onglet "Mon profil CFA"
   - Remplir : dénomination, UAI, SIRET, adresse

3. **Créer un contrat**
   - Dashboard CFA → Bouton "Nouveau contrat"
   - Sélectionner une entreprise existante ou en créer une
   - Copier les liens étudiant et entreprise

4. **Remplir le formulaire apprenti**
   - Ouvrir le lien étudiant
   - Remplir tous les champs
   - Soumettre

5. **Remplir le formulaire entreprise**
   - Ouvrir le lien entreprise
   - Taper le SIRET → auto-lookup depuis l'annuaire
   - Remplir les champs manquants
   - Soumettre

6. **Générer le PDF**
   - Dashboard CFA → Cliquer sur le contrat
   - Bouton "Générer le PDF CERFA"
   - Télécharger le PDF pré-rempli

---

## 🔐 Authentification

### JWT (JSON Web Tokens)

- **Secret** : `JWT_SECRET` (env var)
- **Durée** : 7 jours
- **Stockage** : localStorage (`auth_token`, `auth_user`)

### Rôles

- **CFA** : Accès aux contrats, maîtres apprentissage, profil, annuaire
- **Entreprise** : Accès au profil, contrats liés, formulaires

---

## 📊 Annuaire partagé d'entreprises

L'annuaire s'auto-alimente quand :

1. Une **entreprise** remplit un formulaire via token
2. Une **entreprise** sauvegarde son profil
3. Un **CFA** modifie les données entreprise d'un contrat

### Utilisation côté CFA

- **edit-contrat.html** : Barre de recherche "🔍 Rechercher une entreprise"
- Taper un SIRET ou un nom
- Cliquer sur un résultat → pré-remplit tous les champs

### Utilisation côté Entreprise

- **entreprise.html** : Taper un SIRET valide (14 chiffres)
- Auto-lookup automatique
- Message feedback : ✅ champs pré-remplis ou ℹ️ SIRET non trouvé

---

## 🐛 Dépannage

### "Redis connection failed"

```
Vérifier les variables d'env sur Vercel :
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN

Tester : curl https://saas-cerfa.vercel.app/api/debug
```

### "Token invalide" ou "Non authentifié"

```
Vérifier :
- JWT_SECRET est défini sur Vercel
- localStorage contient auth_token
- Le token n'a pas expiré (7 jours)
```

### "Fichiers PDF/mapping non trouvés"

```
Vérifier vercel.json :
- includeFiles contient :
  - mapping_complet_v2.json
  - cerfa_apprentissage_10103-14.pdf
```

### Données perdues après redéploiement

```
Normal si Redis n'est pas configuré.
Vérifier que UPSTASH_REDIS_REST_URL est défini sur Vercel.
```

---

## 📚 Documentation supplémentaire

- **progress.md** : État détaillé du projet, phases complétées
- **PROJECT.md** : Roadmap SaaS, phases 1-3 complétées
- **api/index.js** : Commentaires détaillés sur chaque route API
- **public/*.html** : Commentaires sur la structure et les fonctions JS

---

## 🤝 Contribution

1. Fork le repo
2. Créer une branche (`git checkout -b feature/...`)
3. Committer (`git commit -m "..."`)
4. Pusher (`git push origin feature/...`)
5. Créer une Pull Request

---

## 📄 Licence

À définir

---

## 📞 Support

Pour les questions ou problèmes :
- Ouvrir une issue sur GitHub
- Consulter les fichiers `.md` du projet

---

**Dernière mise à jour** : Mars 2026
**Version** : 1.0 (MVP complet)
