// ── 图库 ─────────────────────────────────────────────
// 每次保存的图片自动存一份进图库，可以改名、删除，
// 点缩略图回到画布接着画（再保存就是一张新图，原来那张不动）。
// 图片本身比较大，localStorage 放不下，存在浏览器的 IndexedDB 里：
// 只存在这台设备、这个浏览器里，换设备或清掉网站数据就没了。
// 每条：{ id, n, name, created, ext, blob, thumb, state }
//   thumb 是 192px 的小图 dataURL，列表里显示用；state 是画布状态（见 sketch.js 的 snapshotDrawing），
//   有了它才能点回画布继续画，加这个功能之前存的图没有

const _GALLERY_DB = "pixelgraphy";
const _GALLERY_STORE = "gallery";
let _galleryDB = null;

function _openGalleryDB() {
  return (_galleryDB ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(_GALLERY_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(_GALLERY_STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// 开一个事务做事，事务完成后返回 fn 里那个请求的结果
async function _galleryTx(mode, fn) {
  const db = await _openGalleryDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_GALLERY_STORE, mode);
    const req = fn(tx.objectStore(_GALLERY_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

const _galleryAll = () => _galleryTx("readonly", (s) => s.getAll());
const _galleryPut = (item) => _galleryTx("readwrite", (s) => s.put(item));
const _galleryDelete = (id) => _galleryTx("readwrite", (s) => s.delete(id));

// 导出图缩成小图，列表里显示（像素画缩小也保持硬边）
function galleryThumb(canvas) {
  const S = 192;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, S, S);
  return c.toDataURL("image/png");
}

// 保存时调用：存一份进图库，名字默认「作品 N」
async function addToGallery(blob, thumb, ext, state) {
  try {
    const items = await _galleryAll();
    const n = items.reduce((m, x) => Math.max(m, x.n || 0), 0) + 1;
    await _galleryPut({ id: Date.now(), n, name: "", created: Date.now(), ext, blob, thumb, state });
    // 第一次存东西时请浏览器别自动清掉（Safari 会清理很久没打开的网站数据）
    navigator.storage?.persist?.();
    renderGallery();
  } catch (err) {
    console.warn("图库保存失败", err);
  }
}

// 像素垃圾桶：9×10 的格子（把手、桶盖、桶身、两道竖缝），颜色跟着墨色
const TRASH_ICON = `<svg class="pixel-icon" viewBox="0 0 9 10" width="18" height="20" aria-hidden="true" shape-rendering="crispEdges" fill="currentColor">
  <rect x="3" y="0" width="3" height="1"/><rect x="0" y="1" width="9" height="1"/>
  <rect x="1" y="3" width="1" height="7"/><rect x="7" y="3" width="1" height="7"/><rect x="1" y="9" width="7" height="1"/>
  <rect x="3" y="4" width="1" height="4"/><rect x="5" y="4" width="1" height="4"/>
</svg>`;

const galleryName = (item) => item.name || `${t("作品", "Artwork")} ${item.n}`;

// ── 图库弹窗 ─────────────────────────────────────────

let galleryOpen = false;

function openGallery() {
  galleryOpen = true;
  document.getElementById("gallery").hidden = false;
  renderGallery();
}

function closeGallery() {
  galleryOpen = false;
  document.getElementById("gallery").hidden = true;
}

async function renderGallery() {
  const grid = document.getElementById("gallery-grid");
  if (!galleryOpen || !grid) return;
  let items = [];
  try {
    items = await _galleryAll();
  } catch (err) {
    console.warn("图库读取失败", err);
  }
  items.sort((a, b) => b.created - a.created); // 新的在前

  grid.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "gallery-empty";
    empty.textContent = t("还没有作品，保存一张就会出现在这里", "Nothing yet — saved images show up here");
    grid.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "gallery-card";

    // 缩略图：点一下回到画布继续画。画布上有没保存的东西会先问一下，免得被覆盖
    const open = document.createElement("button");
    open.className = "gallery-open";
    const img = document.createElement("img");
    img.src = item.thumb;
    img.alt = galleryName(item);
    open.appendChild(img);
    if (item.state) {
      open.title = t("点一下回到画布继续画", "Tap to keep drawing");
      open.onclick = () => {
        if (!canReplaceCanvas() && !confirm(t("画布上还没保存的内容会被替换，继续吗？", "Your unsaved canvas will be replaced. Continue?")))
          return;
        restoreDrawing(item.state);
        closeGallery();
      };
    } else {
      open.disabled = true;
      open.title = t("这张是旧版本保存的，不能回到画布", "Saved by an older version — can’t be reopened");
    }

    // 名字：直接改，回车或离开输入框就存；清空就回到默认名
    const name = document.createElement("input");
    name.type = "text";
    name.className = "nes-input small-input";
    name.maxLength = 24;
    name.value = item.name;
    name.placeholder = galleryName({ ...item, name: "" });
    name.addEventListener("change", () => {
      item.name = name.value.trim();
      img.alt = galleryName(item);
      _galleryPut(item);
    });
    name.addEventListener("keydown", (e) => e.key === "Enter" && name.blur());

    // 缩略图外面包一层，删除确认要盖在缩略图上
    const thumbBox = document.createElement("div");
    thumbBox.className = "gallery-thumb";
    thumbBox.appendChild(open);

    // 删除：像素垃圾桶。点一下在缩略图上盖一层「确定删除」，点它才删；
    // 点遮罩别处、再点一下垃圾桶、或 3 秒不动都算取消
    const del = document.createElement("button");
    del.className = "nes-btn small-btn gallery-delete";
    del.title = t("删除", "Delete");
    del.setAttribute("aria-label", t("删除", "Delete"));
    del.innerHTML = TRASH_ICON;
    let confirmBox = null, timer = null;
    const cancel = () => {
      clearTimeout(timer);
      confirmBox?.remove();
      confirmBox = null;
      del.classList.remove("tool-active");
    };
    del.onclick = () => {
      if (confirmBox) return cancel();
      del.classList.add("tool-active");
      confirmBox = document.createElement("div");
      confirmBox.className = "gallery-confirm";
      confirmBox.onclick = (e) => e.target === confirmBox && cancel();
      const yes = document.createElement("button");
      yes.className = "nes-btn small-btn";
      yes.textContent = t("确定删除", "Delete");
      yes.onclick = async () => {
        cancel();
        await _galleryDelete(item.id);
        renderGallery();
      };
      confirmBox.appendChild(yes);
      thumbBox.appendChild(confirmBox);
      timer = setTimeout(cancel, 3000);
    };

    // 名字和垃圾桶一行
    const row = document.createElement("div");
    row.className = "gallery-row";
    row.append(name, del);

    card.append(thumbBox, row);
    grid.appendChild(card);
  }
}

document.addEventListener("keydown", (e) => {
  if (galleryOpen && e.key === "Escape") closeGallery();
});
