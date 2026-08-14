// Shared file-location logic for the knowledge-base data files, used by
// server/purchasing.js, server/inventoryStore.js and server/smoking.js.
// The knowledge-base repo lives as a sibling to this project by default:
//   D:\Personal GIT\knowledge-base\Data\{vendors,raw_materials,inventory,purchases,smoking_sessions}.csv
// Override the location with KNOWLEDGE_BASE_DATA_DIR in .env if that repo
// lives somewhere else on a given machine.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FILES = {
  vendors: 'vendors.csv',
  rawMaterials: 'raw_materials.csv',
  inventory: 'inventory.csv',
  purchases: 'purchases.csv',
  smokingSessions: 'smoking_sessions.csv',
  smokingSessionStages: 'smoking_session_stages.csv',
  dailyView: 'daily_view.csv',
  rubRecipes: 'rub_recipes.csv',
  rubRecipeIngredients: 'rub_recipe_ingredients.csv',
  menu: 'menu.csv',
  recipeIngredients: 'recipe_ingredients.csv',
};

function getDataDir() {
  return process.env.KNOWLEDGE_BASE_DATA_DIR
    ? path.resolve(process.env.KNOWLEDGE_BASE_DATA_DIR)
    : path.resolve(__dirname, '../../knowledge-base/Data');
}

function filePath(name) {
  return path.join(getDataDir(), FILES[name]);
}

function requireFile(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) {
    const err = new Error(
      `Can't find ${FILES[name]} at ${p}. Set KNOWLEDGE_BASE_DATA_DIR in the server's .env if the knowledge-base repo lives somewhere else.`,
    );
    err.status = 503;
    throw err;
  }
  return p;
}

function getConfig() {
  const dataDir = getDataDir();
  const present = Object.fromEntries(
    Object.entries(FILES).map(([key, file]) => [key, fs.existsSync(path.join(dataDir, file))]),
  );
  return { dataDir, present, configured: Object.values(present).every(Boolean) };
}

export { FILES, getDataDir, filePath, requireFile, getConfig };
