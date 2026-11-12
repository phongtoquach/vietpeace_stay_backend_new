-- T04: persistence cho chatbot customer + admin support workflow.
-- Thêm 6 bảng mới: conversations, messages, tickets, knowledge_articles, ticket_feedback, audit_logs.
-- Thiết kế theo workspace/state-machine.md (T02) và workspace/authz-matrix.md (T03).
-- Chạy 1 lần trên database VietPeaceStayDB. Migration idempotent (chạy lại không tạo trùng).
--
-- Lưu ý role: trong DB role của manager là 'ACCOMMODATION_MANAGER'
-- (tài liệu workspace dùng tên MANAGER_ACCOMMODATION — cùng một ý).
--
-- Rollback (chạy tay khi cần, đúng thứ tự con trước cha):
-- DROP TABLE dbo.audit_logs;
-- DROP TABLE dbo.ticket_feedback;
-- DROP TABLE dbo.tickets;
-- DROP TABLE dbo.knowledge_articles;
-- DROP TABLE dbo.messages;
-- DROP TABLE dbo.conversations;

-- 1. conversations: phiên chat ACTIVE/CLOSED (state-machine.md mục 3)
IF OBJECT_ID(N'dbo.conversations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.conversations (
        id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_conversations PRIMARY KEY,
        session_key VARCHAR(64) NOT NULL,
        user_id UNIQUEIDENTIFIER NULL,
        status VARCHAR(20) NOT NULL
            CONSTRAINT DF_conversations_status DEFAULT 'ACTIVE',
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_conversations_created_at DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NULL,
        closed_at DATETIME2 NULL,
        CONSTRAINT FK_conversations_user FOREIGN KEY (user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT CK_conversations_status CHECK (status IN ('ACTIVE','CLOSED'))
    );
    CREATE INDEX IX_conversations_user_id ON dbo.conversations(user_id);
    CREATE INDEX IX_conversations_session_key ON dbo.conversations(session_key);
END;

-- 2. messages: append-only, không state machine riêng (state-machine.md mục 3)
IF OBJECT_ID(N'dbo.messages', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.messages (
        id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_messages PRIMARY KEY,
        conversation_id BIGINT NOT NULL,
        sender_type VARCHAR(20) NOT NULL,
        sender_user_id UNIQUEIDENTIFIER NULL,
        content NVARCHAR(MAX) NOT NULL,
        is_internal_note BIT NOT NULL
            CONSTRAINT DF_messages_is_internal_note DEFAULT 0,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_messages_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_messages_conversation FOREIGN KEY (conversation_id)
            REFERENCES dbo.conversations(id),
        CONSTRAINT FK_messages_sender_user FOREIGN KEY (sender_user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT CK_messages_sender_type CHECK (
            sender_type IN ('CUSTOMER','GUEST','BOT','STAFF','SYSTEM')),
        CONSTRAINT CK_messages_sender_user CHECK (
            (sender_type IN ('CUSTOMER','STAFF') AND sender_user_id IS NOT NULL)
            OR (sender_type IN ('GUEST','BOT','SYSTEM') AND sender_user_id IS NULL))
    );
    CREATE INDEX IX_messages_conversation_id ON dbo.messages(conversation_id, id);
END;

-- 3. tickets: 7 trạng thái + 7 category (state-machine.md mục 4-5)
-- accommodation_id là scope chính; có booking_id thì bắt buộc có accommodation_id
-- (authz-matrix.md mục 3.2, model-plan.md ticket handoff)
IF OBJECT_ID(N'dbo.tickets', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tickets (
        id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_tickets PRIMARY KEY,
        ticket_code VARCHAR(50) NOT NULL,
        user_id UNIQUEIDENTIFIER NULL,
        conversation_id BIGINT NOT NULL,
        booking_id BIGINT NULL,
        accommodation_id INT NULL,
        category VARCHAR(50) NOT NULL,
        subject NVARCHAR(255) NOT NULL,
        status VARCHAR(30) NOT NULL
            CONSTRAINT DF_tickets_status DEFAULT 'OPEN',
        assigned_to_user_id UNIQUEIDENTIFIER NULL,
        assigned_at DATETIME2 NULL,
        reason NVARCHAR(1000) NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_tickets_created_at DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NULL,
        resolved_at DATETIME2 NULL,
        closed_at DATETIME2 NULL,
        cancelled_at DATETIME2 NULL,
        CONSTRAINT UQ_tickets_ticket_code UNIQUE (ticket_code),
        CONSTRAINT FK_tickets_user FOREIGN KEY (user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT FK_tickets_conversation FOREIGN KEY (conversation_id)
            REFERENCES dbo.conversations(id),
        CONSTRAINT FK_tickets_booking FOREIGN KEY (booking_id)
            REFERENCES dbo.bookings(id),
        CONSTRAINT FK_tickets_accommodation FOREIGN KEY (accommodation_id)
            REFERENCES dbo.accommodations(id),
        CONSTRAINT FK_tickets_assignee FOREIGN KEY (assigned_to_user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT CK_tickets_status CHECK (status IN (
            'OPEN','ASSIGNED','IN_PROGRESS','WAITING_CUSTOMER',
            'RESOLVED','CLOSED','CANCELLED')),
        CONSTRAINT CK_tickets_category CHECK (category IN (
            'CANCEL_REFUND','BOOKING_CHANGE','PAYMENT_PROBLEM',
            'REFUND_REQUEST','HUMAN_SUPPORT','COMPLAINT','FEEDBACK')),
        CONSTRAINT CK_tickets_scope CHECK (
            booking_id IS NULL OR accommodation_id IS NOT NULL)
    );
    CREATE INDEX IX_tickets_user_id ON dbo.tickets(user_id);
    CREATE INDEX IX_tickets_accommodation_id ON dbo.tickets(accommodation_id);
    CREATE INDEX IX_tickets_assigned_to ON dbo.tickets(assigned_to_user_id);
    CREATE INDEX IX_tickets_status ON dbo.tickets(status);
    CREATE INDEX IX_tickets_booking_id ON dbo.tickets(booking_id);
END;

-- 4. knowledge_articles: FAQ/tra cứu cho intent CONSULT (intents.md mục 4.1)
IF OBJECT_ID(N'dbo.knowledge_articles', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.knowledge_articles (
        id INT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_knowledge_articles PRIMARY KEY,
        title NVARCHAR(255) NOT NULL,
        keywords NVARCHAR(500) NULL,
        content NVARCHAR(MAX) NOT NULL,
        is_active BIT NOT NULL
            CONSTRAINT DF_knowledge_articles_is_active DEFAULT 1,
        created_by_user_id UNIQUEIDENTIFIER NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_knowledge_articles_created_at DEFAULT SYSUTCDATETIME(),
        updated_at DATETIME2 NULL,
        CONSTRAINT FK_knowledge_articles_creator FOREIGN KEY (created_by_user_id)
            REFERENCES dbo.users(id)
    );
    CREATE INDEX IX_knowledge_articles_active ON dbo.knowledge_articles(is_active);
END;

-- 5. ticket_feedback: đánh giá sau xử lý, 1-1 với ticket (authz-matrix.md mục 3.2)
IF OBJECT_ID(N'dbo.ticket_feedback', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.ticket_feedback (
        id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_ticket_feedback PRIMARY KEY,
        ticket_id BIGINT NOT NULL,
        user_id UNIQUEIDENTIFIER NULL,
        rating TINYINT NOT NULL,
        comment NVARCHAR(1000) NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_ticket_feedback_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_ticket_feedback_ticket FOREIGN KEY (ticket_id)
            REFERENCES dbo.tickets(id),
        CONSTRAINT FK_ticket_feedback_user FOREIGN KEY (user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT UQ_ticket_feedback_ticket UNIQUE (ticket_id),
        CONSTRAINT CK_ticket_feedback_rating CHECK (rating BETWEEN 1 AND 5)
    );
END;

-- 6. audit_logs: log allow/deny/escalate (output-contract.md D09, criterion C15)
-- actor_type dùng giá trị role thật trong DB: ACCOMMODATION_MANAGER
IF OBJECT_ID(N'dbo.audit_logs', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.audit_logs (
        id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_audit_logs PRIMARY KEY,
        actor_type VARCHAR(30) NOT NULL,
        actor_user_id UNIQUEIDENTIFIER NULL,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50) NULL,
        resource_id BIGINT NULL,
        decision VARCHAR(20) NOT NULL,
        reason NVARCHAR(1000) NULL,
        detail_json NVARCHAR(MAX) NULL,
        created_at DATETIME2 NOT NULL
            CONSTRAINT DF_audit_logs_created_at DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_audit_logs_actor_user FOREIGN KEY (actor_user_id)
            REFERENCES dbo.users(id),
        CONSTRAINT CK_audit_logs_actor_type CHECK (actor_type IN (
            'GUEST','CUSTOMER','ACCOMMODATION_MANAGER','ADMIN','SYSTEM')),
        CONSTRAINT CK_audit_logs_decision CHECK (decision IN ('ALLOW','DENY','ESCALATE'))
    );
    CREATE INDEX IX_audit_logs_actor ON dbo.audit_logs(actor_user_id);
    CREATE INDEX IX_audit_logs_action ON dbo.audit_logs(action);
    CREATE INDEX IX_audit_logs_resource ON dbo.audit_logs(resource_type, resource_id);
    CREATE INDEX IX_audit_logs_created_at ON dbo.audit_logs(created_at);
END;
