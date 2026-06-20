package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// ============================================================
// MODELOS DE DATOS
// ============================================================

// DocumentShipment representa un envío de documento oficial
type DocumentShipment struct {
	ShipmentID   string         `json:"shipmentId"`
	SenderID     string         `json:"senderId"`
	RecipientID  string         `json:"recipientId"`
	IPFSHash     string         `json:"ipfsHash"`
	FileName     string         `json:"fileName"`
	FileType     string         `json:"fileType"`
	FileSize     int64          `json:"fileSize"`
	Description  string         `json:"description"`
	Status       ShipmentStatus `json:"status"`
	SentAt       string         `json:"sentAt"`
	UpdatedAt    string         `json:"updatedAt"`
	IPFSDeleted  bool           `json:"ipfsDeleted"`  // true si el fichero fue eliminado de IPFS
	QueryHistory []QueryRecord  `json:"queryHistory"`
}

type ShipmentStatus string

const (
	StatusPending   ShipmentStatus = "PENDING"
	StatusRead      ShipmentStatus = "READ"
	StatusConfirmed ShipmentStatus = "CONFIRMED"
	StatusRejected  ShipmentStatus = "REJECTED"

	// Tipos de consulta para el historial
	QueryTypeSend       = "SEND"          // registro inicial del envío
	QueryTypeRead       = "READ"          // consulta del objeto en el chaincode
	QueryTypeFileAccess = "FILE_ACCESS"   // acceso al fichero en IPFS
	QueryTypeFileDelete = "FILE_DELETED"  // borrado del fichero en IPFS

	// Índices compuestos para LevelDB
	indexBySender    = "sender~shipmentId"
	indexByRecipient = "recipient~shipmentId"
)

// QueryRecord registra cada interacción con el envío o su fichero
type QueryRecord struct {
	QueryBy   string `json:"queryBy"`   // identidad del usuario
	QueryAt   string `json:"queryAt"`   // timestamp RFC3339
	QueryType string `json:"queryType"` // SEND | READ | FILE_ACCESS | FILE_DELETED | STATUS_UPDATE:X
}

// ============================================================
// CONTRATO
// ============================================================

type DocRegistryContract struct {
	contractapi.Contract
}

// ============================================================
// ESCRITURA
// ============================================================

// SendDocument registra un nuevo envío de documento.
// Crea el objeto principal + dos entradas de índice (por remitente y destinatario).
func (c *DocRegistryContract) SendDocument(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
	recipientID string,
	ipfsHash string,
	fileName string,
	fileType string,
	fileSize int64,
	description string,
) error {
	existing, err := ctx.GetStub().GetState(shipmentID)
	if err != nil {
		return fmt.Errorf("error al consultar el ledger: %w", err)
	}
	if existing != nil {
		return fmt.Errorf("ya existe un envío con el ID '%s'", shipmentID)
	}

	senderID, err := getSenderIdentity(ctx)
	if err != nil {
		return fmt.Errorf("no se pudo obtener la identidad del remitente: %w", err)
	}

	if ipfsHash == "" {
		return fmt.Errorf("el hash IPFS no puede estar vacío")
	}
	if recipientID == "" {
		return fmt.Errorf("el destinatario no puede estar vacío")
	}
	if senderID == recipientID {
		return fmt.Errorf("el remitente y el destinatario no pueden ser el mismo")
	}

	now := time.Now().UTC().Format(time.RFC3339)

	shipment := DocumentShipment{
		ShipmentID:  shipmentID,
		SenderID:    senderID,
		RecipientID: recipientID,
		IPFSHash:    ipfsHash,
		FileName:    fileName,
		FileType:    fileType,
		FileSize:    fileSize,
		Description: description,
		Status:      StatusPending,
		SentAt:      now,
		UpdatedAt:   now,
		IPFSDeleted: false,
		QueryHistory: []QueryRecord{
			{
				QueryBy:   senderID,
				QueryAt:   now,
				QueryType: QueryTypeSend,
			},
		},
	}

	shipmentJSON, err := json.Marshal(shipment)
	if err != nil {
		return fmt.Errorf("error al serializar el envío: %w", err)
	}

	if err := ctx.GetStub().PutState(shipmentID, shipmentJSON); err != nil {
		return fmt.Errorf("error al guardar en el ledger: %w", err)
	}

	// Índice por remitente
	senderKey, err := ctx.GetStub().CreateCompositeKey(indexBySender, []string{senderID, shipmentID})
	if err != nil {
		return fmt.Errorf("error al crear índice de remitente: %w", err)
	}
	if err := ctx.GetStub().PutState(senderKey, []byte{0x00}); err != nil {
		return fmt.Errorf("error al guardar índice de remitente: %w", err)
	}

	// Índice por destinatario
	recipientKey, err := ctx.GetStub().CreateCompositeKey(indexByRecipient, []string{recipientID, shipmentID})
	if err != nil {
		return fmt.Errorf("error al crear índice de destinatario: %w", err)
	}
	if err := ctx.GetStub().PutState(recipientKey, []byte{0x00}); err != nil {
		return fmt.Errorf("error al guardar índice de destinatario: %w", err)
	}

	eventPayload := fmt.Sprintf(`{"shipmentId":"%s","senderId":"%s","recipientId":"%s"}`,
		shipmentID, senderID, recipientID)
	_ = ctx.GetStub().SetEvent("DocumentSent", []byte(eventPayload))

	return nil
}

// UpdateStatus permite al destinatario cambiar el estado de un envío.
// Estados válidos: READ, CONFIRMED, REJECTED
func (c *DocRegistryContract) UpdateStatus(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
	newStatus string,
) error {
	shipment, err := c.getShipmentOrError(ctx, shipmentID)
	if err != nil {
		return err
	}

	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return err
	}

	if callerID != shipment.RecipientID {
		return fmt.Errorf("solo el destinatario puede actualizar el estado del envío")
	}

	status := ShipmentStatus(newStatus)
	if !isValidStatus(status) {
		return fmt.Errorf("estado '%s' no válido. Use: READ, CONFIRMED, REJECTED", newStatus)
	}
	if shipment.Status == StatusConfirmed || shipment.Status == StatusRejected {
		return fmt.Errorf("el envío ya está en estado final '%s' y no puede modificarse", shipment.Status)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	shipment.Status = status
	shipment.UpdatedAt = now
	shipment.QueryHistory = append(shipment.QueryHistory, QueryRecord{
		QueryBy:   callerID,
		QueryAt:   now,
		QueryType: "STATUS_UPDATE:" + newStatus,
	})

	return c.putShipment(ctx, shipment)
}

// RegisterAccess registra on-chain que un usuario ha accedido al fichero en IPFS.
// La app debe llamar a esta función ANTES de redirigir al usuario a la URL de IPFS.
// Solo el remitente o el destinatario pueden registrar un acceso.
func (c *DocRegistryContract) RegisterAccess(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
) error {
	shipment, err := c.getShipmentOrError(ctx, shipmentID)
	if err != nil {
		return err
	}

	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return err
	}

	// Solo las partes del envío pueden registrar accesos
	if callerID != shipment.SenderID && callerID != shipment.RecipientID {
		return fmt.Errorf("acceso denegado: no eres parte de este envío")
	}

	// No tiene sentido acceder a un fichero ya eliminado de IPFS
	if shipment.IPFSDeleted {
		return fmt.Errorf("el fichero de este envío ha sido eliminado de IPFS")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	shipment.QueryHistory = append(shipment.QueryHistory, QueryRecord{
		QueryBy:   callerID,
		QueryAt:   now,
		QueryType: QueryTypeFileAccess,
	})
	shipment.UpdatedAt = now

	return c.putShipment(ctx, shipment)
}

// RegisterDeletion registra on-chain que el fichero ha sido eliminado de IPFS.
// La app debe llamar a esta función DESPUÉS de borrar el fichero en IPFS.
// Solo el remitente o el destinatario pueden registrar un borrado.
func (c *DocRegistryContract) RegisterDeletion(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
) error {
	shipment, err := c.getShipmentOrError(ctx, shipmentID)
	if err != nil {
		return err
	}

	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return err
	}

	// Solo las partes del envío pueden registrar el borrado
	if callerID != shipment.SenderID && callerID != shipment.RecipientID {
		return fmt.Errorf("acceso denegado: no eres parte de este envío")
	}

	// Evitar registrar un borrado duplicado
	if shipment.IPFSDeleted {
		return fmt.Errorf("el fichero de este envío ya fue registrado como eliminado")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	shipment.IPFSDeleted = true
	shipment.UpdatedAt = now
	shipment.QueryHistory = append(shipment.QueryHistory, QueryRecord{
		QueryBy:   callerID,
		QueryAt:   now,
		QueryType: QueryTypeFileDelete,
	})

	if err := c.putShipment(ctx, shipment); err != nil {
		return err
	}

	// Emitir evento para que la app pueda reaccionar
	eventPayload := fmt.Sprintf(`{"shipmentId":"%s","deletedBy":"%s"}`, shipmentID, callerID)
	_ = ctx.GetStub().SetEvent("FileDeleted", []byte(eventPayload))

	return nil
}

// ============================================================
// LECTURA
// ============================================================

// GetShipment devuelve un envío y registra la consulta en el historial.
// Solo el remitente o destinatario pueden acceder.
func (c *DocRegistryContract) GetShipment(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
) (*DocumentShipment, error) {
	shipment, err := c.getShipmentOrError(ctx, shipmentID)
	if err != nil {
		return nil, err
	}

	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return nil, err
	}

	if callerID != shipment.SenderID && callerID != shipment.RecipientID {
		return nil, fmt.Errorf("acceso denegado: no eres parte de este envío")
	}

	// Registrar auditoría de la consulta
	shipment.QueryHistory = append(shipment.QueryHistory, QueryRecord{
		QueryBy:   callerID,
		QueryAt:   time.Now().UTC().Format(time.RFC3339),
		QueryType: QueryTypeRead,
	})

	if err := c.putShipment(ctx, shipment); err != nil {
		return nil, fmt.Errorf("error al registrar auditoría: %w", err)
	}

	return shipment, nil
}

// GetInbox devuelve todos los envíos recibidos por el caller.
func (c *DocRegistryContract) GetInbox(
	ctx contractapi.TransactionContextInterface,
) ([]*DocumentShipment, error) {
	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return nil, err
	}
	return c.getShipmentsByIndex(ctx, indexByRecipient, callerID)
}

// GetSent devuelve todos los envíos realizados por el caller.
func (c *DocRegistryContract) GetSent(
	ctx contractapi.TransactionContextInterface,
) ([]*DocumentShipment, error) {
	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return nil, err
	}
	return c.getShipmentsByIndex(ctx, indexBySender, callerID)
}

// GetMyShipments devuelve todos los envíos donde el caller participa.
func (c *DocRegistryContract) GetMyShipments(
	ctx contractapi.TransactionContextInterface,
) ([]*DocumentShipment, error) {
	sent, err := c.GetSent(ctx)
	if err != nil {
		return nil, err
	}
	received, err := c.GetInbox(ctx)
	if err != nil {
		return nil, err
	}

	seen := make(map[string]bool)
	var all []*DocumentShipment

	for _, s := range sent {
		if !seen[s.ShipmentID] {
			seen[s.ShipmentID] = true
			all = append(all, s)
		}
	}
	for _, s := range received {
		if !seen[s.ShipmentID] {
			seen[s.ShipmentID] = true
			all = append(all, s)
		}
	}

	return all, nil
}

// GetShipmentHistory devuelve el historial de transacciones de Fabric
// para un envío dado. Muestra cada cambio con su txId y timestamp.
func (c *DocRegistryContract) GetShipmentHistory(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
) ([]map[string]interface{}, error) {
	shipment, err := c.getShipmentOrError(ctx, shipmentID)
	if err != nil {
		return nil, err
	}

	callerID, err := getSenderIdentity(ctx)
	if err != nil {
		return nil, err
	}

	if callerID != shipment.SenderID && callerID != shipment.RecipientID {
		return nil, fmt.Errorf("acceso denegado: no eres parte de este envío")
	}

	resultsIterator, err := ctx.GetStub().GetHistoryForKey(shipmentID)
	if err != nil {
		return nil, fmt.Errorf("error al obtener historial: %w", err)
	}
	defer resultsIterator.Close()

	var history []map[string]interface{}
	for resultsIterator.HasNext() {
		response, err := resultsIterator.Next()
		if err != nil {
			return nil, err
		}

		record := map[string]interface{}{
			"txId":      response.TxId,
			"timestamp": response.Timestamp.AsTime().UTC().Format(time.RFC3339),
			"isDelete":  response.IsDelete,
		}

		if !response.IsDelete {
			var shipmentData DocumentShipment
			if err := json.Unmarshal(response.Value, &shipmentData); err == nil {
				record["data"] = shipmentData
			}
		}

		history = append(history, record)
	}

	return history, nil
}

// ============================================================
// HELPERS INTERNOS
// ============================================================

func (c *DocRegistryContract) getShipmentsByIndex(
	ctx contractapi.TransactionContextInterface,
	indexName string,
	partialKey string,
) ([]*DocumentShipment, error) {
	resultsIterator, err := ctx.GetStub().GetStateByPartialCompositeKey(indexName, []string{partialKey})
	if err != nil {
		return nil, fmt.Errorf("error al iterar índice '%s': %w", indexName, err)
	}
	defer resultsIterator.Close()

	var shipments []*DocumentShipment
	for resultsIterator.HasNext() {
		responseRange, err := resultsIterator.Next()
		if err != nil {
			return nil, err
		}

		_, compositeKeyParts, err := ctx.GetStub().SplitCompositeKey(responseRange.Key)
		if err != nil {
			return nil, fmt.Errorf("error al descomponer clave compuesta: %w", err)
		}
		if len(compositeKeyParts) < 2 {
			continue
		}

		shipmentID := compositeKeyParts[1]
		shipment, err := c.getShipmentOrError(ctx, shipmentID)
		if err != nil {
			continue
		}
		shipments = append(shipments, shipment)
	}

	return shipments, nil
}

func (c *DocRegistryContract) getShipmentOrError(
	ctx contractapi.TransactionContextInterface,
	shipmentID string,
) (*DocumentShipment, error) {
	data, err := ctx.GetStub().GetState(shipmentID)
	if err != nil {
		return nil, fmt.Errorf("error al leer el ledger: %w", err)
	}
	if data == nil {
		return nil, fmt.Errorf("envío '%s' no encontrado", shipmentID)
	}

	var shipment DocumentShipment
	if err := json.Unmarshal(data, &shipment); err != nil {
		return nil, fmt.Errorf("error al deserializar el envío: %w", err)
	}
	return &shipment, nil
}

func (c *DocRegistryContract) putShipment(
	ctx contractapi.TransactionContextInterface,
	shipment *DocumentShipment,
) error {
	data, err := json.Marshal(shipment)
	if err != nil {
		return fmt.Errorf("error al serializar: %w", err)
	}
	return ctx.GetStub().PutState(shipment.ShipmentID, data)
}

// getSenderIdentity extrae el ID del cliente que invoca la transacción.
// Prioriza el atributo "userId" del certificado X.509.
// Si no existe, usa MSPID::Subject como identificador compuesto.
func getSenderIdentity(ctx contractapi.TransactionContextInterface) (string, error) {
	clientID := ctx.GetClientIdentity()

	userID, found, err := clientID.GetAttributeValue("userId")
	if err == nil && found && userID != "" {
		return userID, nil
	}

	mspID, err := clientID.GetMSPID()
	if err != nil {
		return "", fmt.Errorf("no se pudo obtener el MSPID: %w", err)
	}

	id, err := clientID.GetID()
	if err != nil {
		return "", fmt.Errorf("no se pudo obtener el ID del cliente: %w", err)
	}

	return fmt.Sprintf("%s::%s", mspID, id), nil
}

func isValidStatus(s ShipmentStatus) bool {
	return s == StatusRead || s == StatusConfirmed || s == StatusRejected
}

// ============================================================
// PUNTO DE ENTRADA
// ============================================================

func main() {
	chaincode, err := contractapi.NewChaincode(&DocRegistryContract{})
	if err != nil {
		panic(fmt.Sprintf("Error al crear el chaincode: %v", err))
	}

	if err := chaincode.Start(); err != nil {
		panic(fmt.Sprintf("Error al iniciar el chaincode: %v", err))
	}
}
