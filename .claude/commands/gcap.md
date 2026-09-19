# git commit and push 
<!--
  ============================================================
  这是 .claude/commands/ 目录下的自定义斜杠命令模板。
  文件名 = 命令名：html.md → 输入 /html 即可触发。

  每个 .md 文件就是一个命令，文件内容就是给 Claude 的完整 prompt。
  ============================================================
-->

1. 帮我生成一个和我风格类似的 git commit message （需要整合概括，每个功能点控制在20字以内，总字数小于50字）

2. 填充commit message 并且执行commit命令，（需要提交Untracked的文件），但是如果代码改动和本次对话中的修改无关，请忽略这个文件

3. git push

<!--
  你的命令被调用后，Claude 会把你下面写的所有内容当作系统指令来执行。
  所以写法就是：直接告诉 Claude 要做什么、按什么步骤来。
-->

## 参数说明

如果 `$ARGUMENTS` 为空，判断用户git工作区是否为空, 如果为空，那么不需要 git commit and push 直接 build

如果 `$ARGUMENTS` 有内容，请结合用户参数修改

- 如果用户要求输出 html，或者参数中携带了html，参考 /html 命令输出html到桌面
- 
- 如果用户参数中有 build / yarn build ，那么同时运行 yarn build 输出一个打包好的zip并提示

---