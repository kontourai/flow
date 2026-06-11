# Regenerate docs/assets/flow-demo.gif with scripts/docs-site/record-demo.sh
Output docs/assets/flow-demo.gif
Set Shell "bash"
Set FontSize 15
Set Width 1000
Set Height 620
Set Padding 24
Set Theme { "background": "#0a0e13", "foreground": "#eef3f8", "black": "#16202d", "red": "#ff6f6f", "green": "#34d399", "yellow": "#f3b14b", "blue": "#7aa2ff", "magenta": "#5cc4e0", "cyan": "#5ce0c6", "white": "#eef3f8", "brightBlack": "#72869b", "brightRed": "#ff6f6f", "brightGreen": "#34d399", "brightYellow": "#f3b14b", "brightBlue": "#7aa2ff", "brightMagenta": "#5cc4e0", "brightCyan": "#5ce0c6", "brightWhite": "#ffffff", "cursor": "#5cc4e0" }
Set TypingSpeed 35ms

Hide
Type "cd $FLOW_DEMO_DIR && clear"
Enter
Show

Type "flow init --demo"
Sleep 500ms
Enter
Sleep 2s

Type "flow status demo"
Sleep 500ms
Enter
Sleep 3.5s

Type "flow evaluate demo --exit-code || echo BLOCKED"
Sleep 500ms
Enter
Sleep 3.5s

Type "flow resume demo"
Sleep 500ms
Enter
Sleep 5s
