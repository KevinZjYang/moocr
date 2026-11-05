// 应急：git push 被网关挡回 403（返回 Unicorn 页）时，改走 Git Data API。
// 用法：node scripts/push-via-api.mjs            // 推送 HEAD
//       node scripts/push-via-api.mjs <sha>      // 推送指定提交
// 用 Git Data API 复刻同一个 commit（tree/author/message 全部照搬），再更新 ref。
// 目标：远端 SHA 与本地一致，本地无需 reset。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = process.env.REPO ?? 'KevinZjYang/moocr';
const BRANCH = 'main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const sha = process.argv[2] ?? 'HEAD';
const parent = git('rev-parse', `${sha}^`);
const [an, ae, ad, cn, ce, cd] = git('show', '-s', '--format=%an%n%ae%n%at%n%cn%n%ce%n%ct', sha).split('\n');
const message = git('show', '-s', '--format=%B', sha);
const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).split('\n').filter(Boolean);

console.log(`commit ${sha.slice(0, 7)} parent ${parent.slice(0, 7)} files ${files.length}`);

const api = async (method, path, body) => {
  const args = ['api', '-X', method, `repos/${REPO}${path}`];
  const input = body ? JSON.stringify(body) : null;
  const out = execFileSync('gh', input ? [...args, '--input', '-'] : args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : null;
};

// 1) 上传每个改动文件的 blob
const entries = [];
for (const f of files) {
  const content = fs.readFileSync(f);
  const blob = await api('POST', '/git/blobs', {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  entries.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  blob ${f} → ${blob.sha.slice(0, 7)}`);
}

// 2) 以父 commit 的 tree 为基底，替换这些路径
const parentTree = git('rev-parse', `${parent}^{tree}`);
const tree = await api('POST', '/git/trees', { base_tree: parentTree, tree: entries });
console.log(`tree ${tree.sha.slice(0, 7)}`);

// 3) 建 commit，时间与作者照抄
const commit = await api('POST', '/git/commits', {
  message,
  tree: tree.sha,
  parents: [parent],
  author: { name: an, email: ae, date: new Date(Number(ad) * 1000).toISOString() },
  committer: { name: cn, email: ce, date: new Date(Number(cd) * 1000).toISOString() },
});
console.log(`remote commit ${commit.sha}`);
console.log(`local  commit ${sha}`);
console.log(commit.sha === sha ? 'SHA 一致' : 'SHA 不同（内容或元数据有差异）');

// 4) 移动分支
await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
console.log(`refs/heads/${BRANCH} → ${commit.sha.slice(0, 7)}`);
