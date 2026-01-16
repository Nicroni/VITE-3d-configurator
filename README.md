# Vite 3D Configurator

Энэ төсөл нь **Vite**, **Three.js**, болон **GLTF** модел ашиглан 3D T-shirt configurator үүсгэх demo юм.

## 🚀 Төслийг локал дээр ажиллуулах

### 1. Репог татах

git clone https://github.com/Nicroni/VITE-3d-configurator.git
cd VITE-3d-configurator


### 2. Шаардлагатай package-уудыг суулгах


npm install


### 3. Development server ажиллуулах


npm run dev


Командын мөрөнд дараах URL гарч ирнэ:

    http://localhost:5173/

Үүнийг browser-оор нээгээд төслөө харах боломжтой.

***

## 📦 Build хийх (Production)


npm run build


Build-ээ серверт тавих бол:

    /dist

хавтасыг ашиглана.

***

## 🗂 Төслийн бүтэц

    assets/       → GLB models, textures
    public/       → Public static assets
    src/          → JS, 3D scene, UI logic
    index.html    → Үндсэн HTML
    vite.config.js → Vite тохиргоо

***

## ✨ Технологиуд

*   Vite
*   JavaScript (ES Modules)
*   Three.js
*   GLTFLoader
*   Canvas 2D + Texture Mapping

***

## 🤝 Хувь нэмэр оруулах

PR, Issue нээлттэй.




