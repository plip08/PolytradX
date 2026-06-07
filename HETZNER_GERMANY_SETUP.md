# Déploiement Hetzner Allemagne

Ce guide est spécifique à Hetzner Cloud, région Allemagne (nbg1 / fsn1).
Il est conçu pour déployer le backend `PolytradX` sur un VPS Docker.

## 1. Créer le serveur

### Option A — Avec l’interface Hetzner

1. Connecte-toi sur https://console.hetzner.cloud
2. Crée un nouveau projet
3. Crée un serveur :
   - Type : `CX11` ou équivalent
   - OS : `Ubuntu 24.04` ou `Ubuntu 22.04`
   - Location : `nbg1` (Nuremberg) ou `fsn1`
   - SSH Key : ta clé publique
   - Nom : `polytradx-bot`

### Option B — Avec le CLI Hetzner

Si tu veux utiliser le CLI, installe-le d’abord :

```bash
curl -O https://github.com/hetznercloud/cli/releases/download/v1.47.0/hcloud-linux-amd64.tar.gz
tar -xzf hcloud-linux-amd64.tar.gz
sudo mv hcloud /usr/local/bin/
```

Puis :

```bash
export HCLOUD_TOKEN="<TON_HCLOUD_TOKEN>"
hcloud server create \
  --name polytradx-bot \
  --type cx11 \
  --image ubuntu-24.04 \
  --location nbg1 \
  --ssh-key "<NOM_DE_TA_CLE_SSH>"
```

## 2. Connexion au serveur

Récupère l’adresse IP publique fournie par Hetzner, puis :

```bash
ssh root@<VPS_IP>
```

## 3. Préparer le serveur

Sur le VPS :

```bash
apt-get update && apt-get upgrade -y
apt-get install -y git
```

## 4. Cloner le projet et déployer

```bash
cd /opt
git clone https://github.com/plip08/PolytradX.git
cd PolytradX
cp .env.example .env
chmod +x setup-vps.sh deploy.sh
./setup-vps.sh
./deploy.sh
```

## 5. Vérifier le déploiement

```bash
docker compose ps
docker compose logs -f backend
```

Le backend Fastify doit être accessible sur :

```bash
http://<VPS_IP>:3000/health/live
```

## 6. Sécurité recommandée

Sur le VPS, active un firewall :

```bash
apt-get install -y ufw
ufw allow OpenSSH
ufw allow 3000
ufw enable
```

> Si tu veux exposer l’API sur un domaine, je te recommande d’ajouter un reverse proxy `nginx` ou `traefik` derrière ce VPS.

## 7. Notes spécifiques Hetzner

- Choisis bien la région `nbg1` ou `fsn1` pour rester en Allemagne.
- Si tu utilises un proxy résidentiel, configure `PROXY_URL` ou `PROXY_SOCKS_URL` dans `.env`.
- Conserve bien les secrets en dehors du repo (ne pas committer `.env`).
