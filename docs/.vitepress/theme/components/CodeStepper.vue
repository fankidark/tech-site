<script setup>
import { ref, computed } from 'vue'

// ============================================================================
// CodeStepper —— 源码逐行对照器（全站共用）
// ----------------------------------------------------------------------------
// 用途：把一段真实源码摊开，配"当前执行到第几行"，并用白话批注每一行在干嘛。
//       文章讲 TLSF 分割、cover 收益裁决、ETC 块编码时，读者最需要的是
//       "这一行改了哪个变量"——静态代码块做不到，这里逐行点亮就行。
//
// 用法：
//   <CodeStepper
//     file="External/Allocator/tlsf/tlsf.c"
//     :lines="[
//       { n: 412, code: 'fl = tlsf_fls(bitmap);', note: '找出最高位非空的一级位图' },
//       { n: 413, code: 'sl = tlsf_fls(...);',     note: '再找二级位图' },
//     ]"
//     :active="0"
//     :vars="[{ name: 'fl', value: '3' }]" />
//
// active 由父组件控制（通常来自 StepPlayer 的当前步），本组件只负责渲染，
// 这样"图解 + 源码 + 变量"三块能严格同步到同一步。
// ============================================================================

const props = defineProps({
  lines: { type: Array, required: true },
  active: { type: Number, default: 0 },
  file: { type: String, default: '' },
  // 当前步的变量快照，展示在右侧
  vars: { type: Array, default: () => [] },
  // 是否显示行号
  lineNumbers: { type: Boolean, default: true },
  // 点击行是否可选中（只做视觉选中，不派发事件）
  clickable: { type: Boolean, default: true },
})

const picked = ref(-1)

function onPick(i) {
  if (!props.clickable) return
  picked.value = picked.value === i ? -1 : i
}

const effective = computed(() => (picked.value >= 0 ? picked.value : props.active))

// 高亮渲染：把 note 里提到的标识符加粗？不做——保持代码原样，避免"看起来像改过源码"
</script>

<template>
  <div class="cs-root">
    <div v-if="file" class="cs-head">
      <span class="cs-file">{{ file }}</span>
      <span class="cs-pos">
        当前第 {{ lines[effective]?.n }} 行 · 共 {{ lines.length }} 行片段
      </span>
    </div>

    <div class="cs-body">
      <ol class="cs-code">
        <li
          v-for="(l, i) in lines"
          :key="i"
          class="cs-line"
          :class="{ on: i === effective, picked: i === picked }"
          @click="onPick(i)"
        >
          <span v-if="lineNumbers" class="cs-ln">{{ l.n }}</span>
          <code class="cs-text">{{ l.code }}</code>
        </li>
      </ol>

      <aside v-if="lines[effective]?.note || vars.length" class="cs-side">
        <div v-if="lines[effective]?.note" class="cs-note">
          <div class="cs-note-head">这行在干什么</div>
          <p>{{ lines[effective].note }}</p>
        </div>
        <div v-if="vars.length" class="cs-vars">
          <div class="cs-vars-head">此刻的变量</div>
          <table>
            <tbody>
              <tr v-for="(v, i) in vars" :key="i">
                <td class="cs-var-name">{{ v.name }}</td>
                <td class="cs-var-val">{{ v.value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </aside>
    </div>

    <p v-if="clickable" class="cs-tip">点任意一行可单独查看该行说明；再点一次回到跟随播放。</p>
  </div>
</template>

<style scoped>
.cs-root {
  margin: 16px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.cs-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 7px 12px;
  border-bottom: 1px solid var(--vp-c-divider);
  font-size: 11.5px;
  font-family: var(--vp-font-family-mono);
}
.cs-file { color: var(--vp-c-text-1); word-break: break-all; }
.cs-pos { margin-left: auto; color: var(--vp-c-text-3); font-family: inherit; }

.cs-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 260px);
}
@media (max-width: 760px) {
  .cs-body { grid-template-columns: 1fr; }
}

.cs-code {
  margin: 0;
  padding: 8px 0;
  list-style: none;
  overflow-x: auto;
  background: var(--vp-code-block-bg);
}
.cs-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 12px 2px 0;
  font-size: 12.5px;
  line-height: 1.75;
  cursor: pointer;
  border-left: 3px solid transparent;
  white-space: pre;
}
.cs-line:hover { background: rgba(128, 128, 128, 0.10); }
.cs-line.on {
  background: rgba(76, 110, 245, 0.16);
  border-left-color: var(--vp-c-brand-1);
}
.cs-line.picked {
  box-shadow: inset 0 0 0 1px var(--vp-c-brand-1);
}
.cs-ln {
  flex: 0 0 46px;
  text-align: right;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
  user-select: none;
}
.cs-text {
  font-family: var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  background: none;
  padding: 0;
}

.cs-side {
  border-left: 1px solid var(--vp-c-divider);
  padding: 10px 12px;
  background: var(--vp-c-bg);
  font-size: 12.5px;
}
@media (max-width: 760px) {
  .cs-side { border-left: 0; border-top: 1px solid var(--vp-c-divider); }
}
.cs-note-head,
.cs-vars-head {
  font-size: 11px;
  color: var(--vp-c-text-3);
  margin-bottom: 4px;
  text-transform: none;
}
.cs-note p {
  margin: 0 0 10px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
.cs-vars table { width: 100%; border-collapse: collapse; display: table; }
.cs-vars td {
  border: 1px solid var(--vp-c-divider);
  padding: 3px 6px;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
}
.cs-var-name { color: var(--vp-c-text-2); }
.cs-var-val { color: var(--vp-c-brand-1); font-weight: 600; }

.cs-tip {
  margin: 0;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--vp-c-text-3);
  border-top: 1px solid var(--vp-c-divider);
}
</style>
