package main

import (
	"context"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	ctx := context.Background()
	container, err := sqlstore.New(ctx, "sqlite3", "file:store/whatsapp.db?_foreign_keys=on", waLog.Stdout("DB", "ERROR", true))
	if err != nil { panic(err) }
	device, err := container.GetFirstDevice(ctx)
	if err != nil { panic(err) }
	client := whatsmeow.NewClient(device, waLog.Stdout("Client", "ERROR", true))
	if err := client.Connect(); err != nil { panic(err) }
	time.Sleep(6 * time.Second)
	groups, err := client.GetJoinedGroups(ctx)
	if err != nil { fmt.Println("ERR:", err) } else {
		fmt.Printf(">>> %d groups\n", len(groups))
		for _, g := range groups {
			fmt.Printf("  %s | %s\n", g.JID.String(), g.Name)
		}
	}
	client.Disconnect()
}
