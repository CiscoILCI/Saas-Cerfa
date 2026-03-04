# CERFA Apprentissage - SaaS

## Description

Application SaaS de remplissage automatique du CERFA 10103-14 (contrat d'apprentissage).  
Le système permet de collecter les données de l'apprenti et de l'entreprise via des formulaires web, puis de générer automatiquement le PDF CERFA pré-rempli.

---

## Architecture technique

### Stack

- **Backend** : Node.js (handler natif Vercel serverless)
- **Frontend** : HTML/CSS/JS vanilla (fichiers statiques dans `public/`)
- **Base de données** : Upstash Redis (REST API)
- **Hébergement** : Vercel
- **PDF** : pdf-lib (remplissage des champs du CERFA)

### Structure des fichiers

```
├── api/
│   └── index.js                          # Handler API serverless (routes, CRUD, génération PDF)
├── public/
│   ├── index.html                        # Dashboard admin (liste des contrats)
│   ├── etudiant.html                     # Formulaire apprenti (accès par token)
│   └── entreprise.html                   # Formulaire entreprise (accès par token)
├── cerfa_ apprentissage_10103-14.pdf     # Template PDF CERFA vierge
├── mapping_complet_v2.json               # Mapping données → champs PDF
├── vercel.json                           # Configuration Vercel (routes, builds)
├── package.json                          # Dépendances Node.js
└── PROJECT.md                            # Ce fichier
```

### Variables d'environnement (Vercel)

| Variable | Description |
|---|---|
| `UPSTASH_REDIS_REST_URL` | URL REST de la base Upstash Redis |
| `UPSTASH_REDIS_REST_TOKEN` | Token d'authentification Upstash Redis |

---

## Fonctionnement actuel

### Flux principal

1. **Admin** crée un contrat via le dashboard (`POST /api/contracts`)
2. Deux **tokens uniques** sont générés : un pour l'apprenti, un pour l'entreprise
3. L'admin envoie les **liens** aux parties concernées
4. **L'apprenti** remplit son formulaire (`/etudiant.html?token=xxx`)
5. **L'entreprise** remplit son formulaire (`/entreprise.html?token=xxx`)
6. Quand les deux sont soumis, le statut passe à `ready`
7. L'admin peut **générer le PDF** CERFA pré-rempli

### Statuts des contrats

- `pending` : aucune donnée soumise
- `partial` : une seule partie a soumis
- `ready` : les deux parties ont soumis, PDF générable

### API Endpoints

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/contracts` | Liste tous les contrats |
| `POST` | `/api/contracts` | Crée un nouveau contrat |
| `GET` | `/api/contract/by-token/:token` | Vérifie un token |
| `POST` | `/api/etudiant/:token` | Soumet données apprenti |
| `POST` | `/api/entreprise/:token` | Soumet données entreprise |
| `GET` | `/api/contracts/:id/generate-pdf` | Génère le PDF CERFA |
| `DELETE` | `/api/contracts/:id` | Supprime un contrat |
| `GET` | `/api/debug` | Debug Redis + fichiers |
| `GET` | `/api/debug-pdf-fields` | Liste les champs du PDF |

---

## Mapping PDF (mapping_complet_v2.json)

Le fichier `mapping_complet_v2.json` fait correspondre les clés de données aux noms des champs du PDF CERFA.

### Sections du mapping

| Section | Description | Rempli par |
|---|---|---|
| `employeur` | Infos employeur (SIRET, adresse, type...) | Entreprise |
| `apprenti` | Infos apprenti (état civil, adresse, situation...) | Étudiant |
| `representant_legal` | Représentant légal (si mineur) | Étudiant |
| `maitre_apprentissage` | Maître d'apprentissage n°1 | Entreprise |
| `maitre_apprentissage_2` | Maître d'apprentissage n°2 (optionnel) | Entreprise |
| `contrat` | Détails du contrat | Entreprise |
| `remuneration` | Grille de rémunération (4 années) | Entreprise |
| `formation` | CFA, diplôme visé, dates formation | Entreprise (+ CFA) |
| `attestation` | Attestation et lieu de signature | Entreprise |

### Cases à cocher du PDF CERFA

| Champ PDF | Mapping | Description |
|---|---|---|
| `Case à cocher 1` | `employeur.type_prive` | Employeur privé |
| `Case à cocher 2` | `employeur.type_public` | Employeur public |
| `Case à cocher 2_2` | `employeur.adhesion_chomage` | Adhésion chômage |
| `Case à cocher 3` | `apprenti.sexe_homme` | Sexe masculin |
| `Case à cocher 4` | `apprenti.sexe_femme` | Sexe féminin |
| `Case à cocher 5` | `apprenti.sportif_haut_niveau_oui` | Sportif haut niveau Oui |
| `Case à cocher 5_2` | `apprenti.sportif_haut_niveau_non` | Sportif haut niveau Non |
| `Case à cocher 5_3` | `apprenti.handicap_oui` | Handicap Oui |
| `Case à cocher 5_4` | `apprenti.handicap_non` | Handicap Non |
| `Case à cocher 5_5` | `contrat.type_contrat_initial` | Contrat initial |
| `Case à cocher 5_6` | `contrat.type_succession` | Succession de contrats |
| `Case à cocher 5_7` | `contrat.type_avenant` | Avenant |
| `Case à cocher 5_8` | `contrat.travail_risque_oui` | Travail à risque Oui |
| `Case à cocher 5_9` | `contrat.travail_risque_non` | Travail à risque Non |
| `Case à cocher 5_10` | `formation.cfa_entreprise_oui` | CFA d'entreprise Oui |
| `Case à cocher 5_11` | `formation.cfa_entreprise_non` | CFA d'entreprise Non |
| `Case à cocher 5_12` | `maitre_apprentissage.atteste_criteres_eligibilite` | Attestation maître (**À VÉRIFIER**) |
| `Case à cocher 5_13` | *Non mappée* | **À identifier** |
| `Case à cocher 5_14` | *Non mappée* | **À identifier** |
| `Case à cocher 6` | `formation.cfa_meme_lieu` | CFA même lieu |
| `Case à cocher 7` | `attestation.pieces_justificatives` | Pièces justificatives |
| `Case à cocher 8` | *Non mappée* | **À identifier** |

> **Note** : Un PDF de test (`test_checkboxes.pdf`) a été généré pour identifier visuellement les cases `5_12`, `5_13`, `5_14` et `8`. Vérification en cours.

---

## Fonctionnalités implémentées

### Formulaire Étudiant (`etudiant.html`)

- [x] État civil complet (nom, prénom, NIR, date naissance, sexe, nationalité)
- [x] Adresse complète
- [x] Situation (formation, diplômes, classe suivie)
- [x] Reconnaissance travailleur handicapé (Oui/Non)
- [x] Sportif de haut niveau (Oui/Non)
- [x] **Section Représentant légal conditionnelle** : visible uniquement si l'étudiant sélectionne "Mineur"
- [x] Formatage automatique : NIR, téléphone, code postal
- [x] Vérification token + détection formulaire déjà rempli

### Formulaire Entreprise (`entreprise.html`)

- [x] Infos employeur (dénomination, SIRET, adresse, type, APE, IDCC)
- [x] Maître d'apprentissage n°1 et n°2 (optionnel)
- [x] Attestation critères d'éligibilité du maître d'apprentissage (case à cocher)
- [x] Détails du contrat (type, dates, durée hebdomadaire, salaire)
- [x] Grille de rémunération (4 années, 2 périodes par année)
- [x] **Section CFA conditionnelle** : visible uniquement si l'entreprise sélectionne "Oui" à "Connaissez-vous les informations du CFA ?"
- [x] Formation (diplôme visé, dates, durée, lieu principal)
- [x] Attestation pièces justificatives
- [x] Formatage automatique : SIRET, téléphone, code postal

### Dashboard Admin (`index.html`)

- [x] Création de contrat
- [x] Liste des contrats avec statut
- [x] Liens partageables (étudiant + entreprise)
- [x] Génération PDF
- [x] Suppression de contrat

---

## Roadmap SaaS

### Phase 1 - Authentification et comptes utilisateurs

- [ ] Système d'authentification (inscription / connexion)
- [ ] Trois rôles : **Admin**, **CFA**, **Entreprise**
- [ ] Gestion des sessions (JWT ou cookies sécurisés)
- [ ] Page de connexion / inscription
- [ ] Middleware d'authentification sur les routes API

### Phase 2 - Profils et données persistantes

- [ ] **Profil CFA** : dénomination, UAI, SIRET, adresse (pré-rempli dans les contrats)
- [ ] **Profil Entreprise** : dénomination, SIRET, adresse, type employeur (pré-rempli dans les contrats)
- [ ] Remplissage automatique des formulaires depuis le profil client
- [ ] Édition du profil utilisateur

### Phase 3 - Gestion avancée des contrats

- [ ] **Statuts de formulaire** : possibilité de bloquer la soumission (brouillon, ouvert, fermé)
- [ ] **Revue avant PDF** : reprendre et modifier les informations du contrat avant génération
- [ ] Historique des contrats par CFA / Entreprise
- [ ] Tableau de bord personnalisé par rôle

### Phase 4 - Fonctionnalités SaaS avancées

- [ ] Multi-tenant : isolation des données par organisation
- [ ] Gestion des abonnements / plans tarifaires
- [ ] Notifications email (rappels, confirmations)
- [ ] Export des données (CSV, Excel)
- [ ] Statistiques et analytics

---

## Bugs connus / Points à vérifier

- [ ] **Mapping attestation maître d'apprentissage** : la case `5_12` doit être vérifiée visuellement sur le PDF de test pour confirmer qu'elle correspond bien à "L'employeur atteste sur l'honneur..."
- [ ] Cases `5_13`, `5_14`, `8` non mappées : identifier à quoi elles correspondent sur le CERFA

---

## Notes techniques

### Redis (Upstash REST API)

- Les données sont stockées dans des hash Redis (`contract:{id}`)
- Les tokens sont mappés via des clés `token:{token}` → `{contractId}:{type}`
- L'API REST est utilisée (pas de TCP) car Vercel serverless ne supporte pas les connexions TCP persistantes

### Génération PDF

- Utilise `pdf-lib` pour charger le template CERFA et remplir les champs
- Les données sont aplaties (`flattenObject`) pour correspondre au mapping
- Les cases à cocher sont cochées si la valeur est `true`, `"true"`, `"OUI"` ou `"on"`
- Les champs non trouvés dans le PDF sont ignorés silencieusement

### Responsive Design

- Conteneur max-width : 900px (étudiant) / 900px (entreprise)
- Media queries : 768px et 480px
- Grille CSS adaptive pour les form-rows
