package main

import (
	"context"
	"fmt"
	"os"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

func main() {
	phone := os.Args[1]
	ctx := context.Background()
	dbLog := waLog.Stdout("DB", "ERROR", true)
	container, err := sqlstore.New(ctx, "sqlite3", "file:store/whatsapp.db?_foreign_keys=on", dbLog)
	if err != nil {
		panic(err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		panic(err)
	}
	client := whatsmeow.NewClient(device, waLog.Stdout("Client", "INFO", true))

	paired := make(chan bool, 1)
	client.AddEventHandler(func(evt interface{}) {
		switch evt.(type) {
		case *events.PairSuccess:
			fmt.Println(">>> PAIR SUCCESS")
			paired <- true
		case *events.Connected:
			fmt.Println(">>> CONNECTED (session established)")
		}
	})

	if err := client.Connect(); err != nil {
		panic(err)
	}
	code, err := client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		panic(err)
	}
	fmt.Printf("\n>>> PAIRING CODE: %s\n\n", code)

	select {
	case <-paired:
		fmt.Println(">>> waiting for session flush...")
		time.Sleep(12 * time.Second)
		fmt.Println(">>> DONE — creds written to store/whatsapp.db")
	case <-time.After(200 * time.Second):
		fmt.Println(">>> TIMED OUT waiting for pair")
	}
	client.Disconnect()
}
