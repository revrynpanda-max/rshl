# 🚀 KAI RSHL: The Ultimate Onboarding & Deployment Guide

Welcome to the KAI RSHL (Recursive Sparse Holographic Lattice) ecosystem. This guide provides the definitive steps for setting up your Discord server, inviting your autonomous agents, and anchoring your identity within the lattice.

---

## 🏗️ Step 1: Create & Secure Your Discord Server
1. **Create a Server**: In Discord, click the **"+"** icon to create a new server. Name it something reflecting your lattice (e.g., "KAI Intelligence Plaza").
2. **Category Structure**: Create a category named **"Lattice Nodes"**.
3. **Channel Mapping**: Create a dedicated text channel for each agent:
    - `#oracle-central`
    - `#leo-node`
    - `#kai-core`
    - `#analyst-node`
    - *(Repeat for each agent in your roster)*

---

## 🤖 Step 2: OAuth2 & Agent Invites
Every agent (Leo, Kai, etc.) is a distinct Discord Application. 
1. **Discord Developer Portal**: Go to the [Discord Dev Portal](https://discord.com/developers/applications).
2. **Select Application**: Click on your bot (e.g., "Leo").
3. **OAuth2 URL Generator**:
    - Select Scopes: `bot`, `applications.commands`.
    - Select Bot Permissions: `Administrator` (Recommended for full autonomy) or `Manage Channels`, `Read/Send Messages`, `Connect`, `Speak`, `Use Voice Activity`.
4. **Invite**: Copy the generated URL into your browser and add the bot to your new server.

---

## 🧬 Step 3: Bio-Anchoring (The Profile Bio)
KAI agents don't just see your name; they see your **identity**.
1. **Discord Profile**: Go to your User Settings -> User Profile.
2. **The "About Me" Bio**: Write a detailed bio. Include your role, your expertise, and your relation to the KAI project.
3. **Lattice Sync**: When you speak to an agent, KAI pulls your Discord Bio and stores it as a **High-Strength Identity Anchor** in the 16,384-dimensional lattice. 
    - *Tip: If you update your bio, the lattice will automatically ingest the new "Truth" about who you are.*

---

## ⚙️ Step 4: Configuration & Mapping
You must map your Discord IDs to the `tools/oracle-discord/.env` and `data/` files.
1. **Developer Mode**: In Discord, go to Settings -> Advanced -> **Enable Developer Mode**.
2. **Get Your ID**: Right-click your name and select **Copy User ID**.
3. **Get Channel IDs**: Right-click each agent's channel and select **Copy Channel ID**.
4. **Syncing the Ecosystem**:
    - Open `tools/oracle-discord/.env`.
    - Set `USER_ID_RYAN` to your User ID.
    - Map each `TRANSCRIPT_CHANNEL_ID_X` to the corresponding channel you created.

---

## 🛡️ Step 5: Permissions & Roles
To ensure the agents can manage the roundtable effectively:
1. **The "Lattice Node" Role**: Create a role in Discord called **"Lattice Node"**. Give it a distinct color.
2. **Assign to Bots**: Assign this role to every KAI agent.
3. **Permissions**: Ensure the role has `View Channels` and `Send Messages` for all channels in the "Lattice Nodes" category.
4. **Manual Registration**: If you want to grant a friend access, right-click their ID and add it to the `voice_users.json` file in the `data/` directory.

---

## 🚀 Step 6: Initializing the Brain
Once your IDs are mapped and the bots are in their channels:
1. **Compile**: Run `cargo build --release` in the root directory.
2. **Install**: Run `npm install` in `tools/oracle-discord`.
3. **Launch**: Run `./run-oracle-discord.ps1`.

**Your lattice is now active. Speak to Leo in the voice channel to verify the "Neural-Sonic-V12" speed.**
