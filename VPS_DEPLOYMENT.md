# Déploiement VPS pour le backend

Ce guide explique comment préparer un VPS étranger, installer Docker, et déployer la stack backend.

## 1. Choisir un VPS

Recommandé pour petit budget :

- Hetzner Cloud CX11
- DigitalOcean Droplet Basic

Choisis une région hors de France (ex. Germany, Netherlands, UK, US).

## 2. Préparer le VPS

### 2.1 Se connecter au VPS

```bash
ssh root@<VPS_IP>
```

### 2.2 Mettre à jour le système

```bash
apt-get update && apt-get upgrade -y
```

### 2.3 Installer Git si besoin

```bash
apt-get install -y git
```

## 3. Déployer le projet sur le VPS

### 3.1 Cloner le repo

```bash
cd /opt
git clone https://github.com/<ton-compte>/<ton-repo>.git polymarket-trading
cd polymarket-trading
```

### 3.2 Copie du fichier d’environnement

```bash
cp .env.example .env
```

Édite `.env` et remplis :

- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `DATABASE_URL`
- `REDIS_URL`
- `POLYGON_RPC_URLS`
- `PRIVATE_KEY`
- `POLYMARKET_API_KEY`
- `JWT_SECRET`
- `TOTP_SECRET`
- `PROXY_URL` ou `PROXY_SOCKS_URL`

### 3.3 Rendre les scripts exécutables

```bash
chmod +x setup-vps.sh deploy.sh
```

### 3.4 Installer Docker et Docker Compose

```bash
./setup-vps.sh
```

### 3.5 Déployer la stack

```bash
./deploy.sh
```

## 4. Vérifier le déploiement

```bash
docker compose ps
docker compose logs -f backend
```

Le backend doit répondre sur le port `3000`.

## 5. Notes de sécurité

- Ne commite jamais `.env`
- Définit un firewall sur le VPS :
  - `ufw allow 22`
  - `ufw allow 3000`
  - `ufw enable`
- Idéalement, expose uniquement le port `3000` via un reverse proxy sécurisé si besoin.

## 6. Remarques Vercel

Le front est déployé séparément sur Vercel.

- Ajoute `NEXT_PUBLIC_CONTROL_API_URL` et `NEXT_PUBLIC_TELEMETRY_WS_URL` dans les variables Vercel.
- Ton domaine Vercel peut rester public, mais le backend doit être accessible depuis l’UI.
