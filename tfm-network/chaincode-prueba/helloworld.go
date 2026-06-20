package main

import (
    "fmt"
    "github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type SmartContract struct {
    contractapi.Contract
}

// Set guarda un mensaje en el ledger
func (s *SmartContract) Set(ctx contractapi.TransactionContextInterface, key string, value string) error {
    return ctx.GetStub().PutState(key, []byte(value))
}

// Get recupera un mensaje del ledger
func (s *SmartContract) Get(ctx contractapi.TransactionContextInterface, key string) (string, error) {
    valueBytes, err := ctx.GetStub().GetState(key)
    if err != nil {
        return "", fmt.Errorf("error leyendo de la red: %v", err)
    }
    if valueBytes == nil {
        return "", fmt.Errorf("la clave %s no existe", key)
    }
    return string(valueBytes), nil
}

func main() {
    chaincode, err := contractapi.NewChaincode(&SmartContract{})
    if err != nil {
        fmt.Printf("Error creando el chaincode: %s", err.Error())
        return
    }
    if err := chaincode.Start(); err != nil {
        fmt.Printf("Error arrancando el chaincode: %s", err.Error())
    }
}
